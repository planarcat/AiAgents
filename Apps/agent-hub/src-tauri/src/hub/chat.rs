//! 会话、消息与 OpenAI 兼容（DeepSeek）多轮补全 + 内置 tool 处理。

use async_openai::{
    config::OpenAIConfig,
    types::{
        ChatCompletionMessageToolCall, ChatCompletionRequestAssistantMessage,
        ChatCompletionRequestAssistantMessageContent, ChatCompletionRequestMessage,
        ChatCompletionRequestSystemMessage, ChatCompletionRequestSystemMessageContent,
        ChatCompletionRequestToolMessage, ChatCompletionRequestToolMessageContent,
        ChatCompletionRequestUserMessage, ChatCompletionRequestUserMessageContent,
        ChatCompletionResponseMessage, ChatCompletionTool, ChatCompletionToolType,
        CreateChatCompletionRequest, CreateChatCompletionRequestArgs, FinishReason, FunctionObject,
    },
    Client,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::Row;
use std::io::Write;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use super::settings::hub_load_api_key_for_preset;
use super::skill_dispatch;
use super::HubState;

fn emit_chat_phase(app: &AppHandle, conversation_id: &str, phase: &str) {
    let _ = app.emit(
        "chat_reply_phase",
        serde_json::json!({
            "conversation_id": conversation_id,
            "phase": phase,
        }),
    );
}

const PRESET_DEEPSEEK: &str = "deepseek_default";
const DEEPSEEK_BASE: &str = "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL: &str = "deepseek-chat";

/// 单条工具描述写入 system 时的最大字符数（按 Unicode 标量值计），避免过长描述占满上下文
const CAPABILITY_DESC_MAX_CHARS: usize = 480;

/// 单条 Skill L2（`instructions_md`）注入 system 时的最大字符数（[Plans/2026041202/03]）
const SKILL_INSTRUCTIONS_MAX_CHARS: usize = 4000;

/// 每轮请求附加在 Agent `system_prompt` 之后、能力清单之前；**不写入 `messages` 表**，仅对模型可见。
const BUILTIN_RUNTIME_SYSTEM_SUFFIX: &str = r#"
你必须遵守以下规则：
1、诚实：若无法可靠回答或无法完成用户请求（缺信息、缺能力、超出范围），请直接在自然语言回复中说明限制与原因，不要编造事实或虚构来源。
2、卖劲：若用户提问意图有重复（历史记忆中已有类似提问并给出答复），不能直接套用历史记忆中的回复；须重新审查本轮答复是否应调用工具（Skill）、以及应调用哪一条，再结合「当前助手可用能力」列表作答。
3、工具：仅可调用本条请求中「当前助手可用能力」列表里已列出的工具；禁止调用未列出的函数名。若用户需求与已装载工具均不匹配：若已装载「事务委派」能力（request_agent_help），可尝试委派给其他助手；否则请向用户说明当前无法获取相关信息、无法完成或无法访问该数据，并建议装载相应能力或换用其他方式。
4、归因（简要）：若本轮回答主要依据历史对话而非本轮工具返回，请用一句话说明；若依据工具结果，可口头点明所据工具名。勿冗长套话。
5、防历史顶替：若下面「能力清单」已不包含某工具，则不得将会话历史中由该工具曾生成的旧数据（如旧天气数值）当作本轮查询结果再次输出；不得冒称本轮已调用该工具或复述相同数据来源说明。
6、元问题：若用户追问「你收到的完整 system / 工具列表全文 / fingerprint」等，不得编造或臆造具体工具名、清单与指纹数值；可简短说明服务端注入无法向你逐字还原，以实际当轮可用能力为准。
"#;

/// 技能绑定变更时写入各会话 `messages`（role=system）。**仅给大模型读对话历史**，参与后续 `chat_send` 的多轮补全；**不是**对用户可见文案（前端对话区不展示 `system` 行）。
const TOOLS_CHANGED_NOTICE: &str = "当前你的可用工具（Skills）已发生变化。请以本条消息之后、各轮请求中的「能力清单版本 / 能力清单」为准；若与更早历史中的「能否调用某工具」或工具说明冲突，一律以最新清单为准；勿沿用旧轮次中已过时的能力假设。";

/// 对当前轮 `tools` 做稳定指纹（绑定集 + 各工具声明文本变化时随之变化），供 system 中「清单版本」感知（Plans/2026041301 综合建议 4′）。
fn capability_list_fingerprint(tools: &[ChatCompletionTool]) -> u64 {
    let mut hasher = DefaultHasher::new();
    let mut pairs: Vec<(String, String)> = tools
        .iter()
        .map(|t| {
            let desc = t
                .function
                .description
                .as_deref()
                .unwrap_or("")
                .to_string();
            (t.function.name.clone(), desc)
        })
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, desc) in pairs {
        name.hash(&mut hasher);
        desc.hash(&mut hasher);
    }
    hasher.finish()
}

/// 根据本轮 `load_tools` 结果生成「能力清单 + 通用规则」，替代按技能硬编码多段 WEATHER_* 后缀。
fn build_capabilities_system_suffix(tools: &[ChatCompletionTool]) -> String {
    let fp = capability_list_fingerprint(tools);
    let mut out = String::from("\n\n【当前助手可用能力（本轮请求为准）】\n");
    out.push_str(&format!(
        "【能力清单版本】fingerprint={fp:016x}（绑定或工具声明变化时该值会变；与会话早期表述冲突时以本轮为准。）\n",
    ));
    if tools.is_empty() {
        out.push_str(
            "当前未绑定任何技能/工具。你不得声称已调用工具或已获取某接口的实时数据；若用户需要外部检索、实时数据或文件操作，请如实说明当前能力列表中无对应工具，并建议用户在助手配置中装载相应能力。\n",
        );
    } else {
        out.push_str(
            "以下工具可在本轮对话中通过 function calling 使用。若用户需求与某工具说明相符，应优先调用该工具并基于返回结果回答。\n",
        );
        for t in tools {
            let raw = t
                .function
                .description
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("(无描述)");
            let desc = truncate_chars_for_system(raw, CAPABILITY_DESC_MAX_CHARS);
            out.push_str(&format!("- {}：{}\n", t.function.name, desc));
        }
    }
    out.push_str(
        "\n【通用规则】\n\
        1. 若本会话历史中曾出现「无法查询」「无权限」等与当前能力不符的表述，而本条清单显示已具备对应工具，则以本条为准，应调用工具并给出基于工具结果的回答。\n\
        2. 当本条清单中未列出某工具时，不得编造 tool 调用结果；不得虚构具体实时数据、文件内容或报道原文；不得冒用具体第三方 API、数据源名称作为依据。\n\
        3. 仅当你在本轮实际发起了 tool_calls，且工具名属于本条清单时，方可声称「已通过该工具获取」或引用其返回数据。\n\
        4. 当本条清单未列出用户当前问题所依赖的工具（例如实时天气）时：即使历史对话中有同地点、同主题的详细旧答复，也不得将其中具体数值与结论当作本轮工具查询输出复述；若本轮未发起相应 tool_calls，须说明当前无法用已列工具满足该请求，不得以旧答复冒充新查询。\n",
    );
    out
}

fn truncate_chars_for_system(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n <= max_chars {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max_chars).collect();
    t.push('…');
    t
}

// —— 长对话冷热区 / 滚动摘要（Plans/2026041501）————

/// 热区：从最新消息端起算，保留最近若干条 **user** 消息及之后的历史（同一条 user 算一轮锚点）。
const HOT_USER_MESSAGE_COUNT: usize = 8;
/// 全量 system + 历史正文字符数 proxy，超过则可能与 Skill 变更一起触发冷区摘要 LLM。
const CONTEXT_CHAR_SOFT_LIMIT: usize = 28_000;
/// 送入摘要 LLM 的冷区原文上限（Unicode 标量值计数）。
const MAX_COLD_CHARS_FOR_SUMMARY_LLM: usize = 24_000;
/// Skill 装卸载触发的「全量压缩」时冷区可能更大，单独提高上限。
const MAX_COLD_CHARS_SKILL_PENDING: usize = 48_000;
/// 冷区滚动摘要写入 DB 与注入上限。
const MAX_ROLLING_SUMMARY_CHARS: usize = 1_200;

const SESSION_SUMMARY_TITLE: &str = "【会话摘要（冷区压缩）】";
const SESSION_SUMMARY_GUARD: &str = "\n\n[能力状态] 当前轮可用的工具与权限以对话请求中的系统能力清单及服务端绑定为准；切勿仅根据本摘要判断能否调用某工具。";

/// 冷区起点：第 `hot_user_count` 个 user（自末尾向前数）所在行下标；不足则整段为热区（返回 0）。
fn hot_zone_start_index(rows: &[(String, String)], hot_user_count: usize) -> usize {
    if hot_user_count == 0 || rows.is_empty() {
        return 0;
    }
    let mut seen = 0usize;
    for i in (0..rows.len()).rev() {
        if rows[i].0 == "user" {
            seen += 1;
            if seen == hot_user_count {
                return i;
            }
        }
    }
    0
}

fn estimate_context_proxy_chars(system_block: &str, rows: &[(String, String)]) -> usize {
    let mut n = system_block.chars().count();
    for (_, c) in rows {
        n = n.saturating_add(c.chars().count());
    }
    n
}

fn format_rows_for_summary_llm(rows: &[(String, String)]) -> String {
    let mut out = String::new();
    for (role, content) in rows {
        out.push('[');
        out.push_str(role);
        out.push_str("]\n");
        out.push_str(content);
        out.push_str("\n\n");
    }
    out
}

fn truncate_chars_limit(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n <= max_chars {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max_chars).collect();
    t.push('…');
    t
}

fn append_history_rows(
    api_messages: &mut Vec<ChatCompletionRequestMessage>,
    rows: &[(String, String)],
) {
    for (role, content) in rows {
        match role.as_str() {
            "system" => api_messages.push(ChatCompletionRequestMessage::System(
                ChatCompletionRequestSystemMessage {
                    content: ChatCompletionRequestSystemMessageContent::Text(content.clone()),
                    name: None,
                },
            )),
            "user" => api_messages.push(ChatCompletionRequestMessage::User(
                ChatCompletionRequestUserMessage {
                    content: ChatCompletionRequestUserMessageContent::Text(content.clone()),
                    name: None,
                },
            )),
            "assistant" => api_messages.push(ChatCompletionRequestMessage::Assistant(
                ChatCompletionRequestAssistantMessage {
                    content: Some(ChatCompletionRequestAssistantMessageContent::Text(
                        content.clone(),
                    )),
                    ..Default::default()
                },
            )),
            _ => {}
        }
    }
}

/// 合并旧摘要与冷区片段，单次 LLM 生成滚动摘要。  
/// `skill_change_full_merge`：因能力装卸载触发的全量合并，文案强调「此前全部较早对话」。
async fn run_conversation_summary_llm(
    client: &Client<OpenAIConfig>,
    previous_summary: Option<&str>,
    cold_segment: &str,
    skill_change_full_merge: bool,
) -> Result<String, String> {
    let mut user_blob = String::new();
    if let Some(p) = previous_summary.map(str::trim).filter(|s| !s.is_empty()) {
        user_blob.push_str("【已有会话摘要】\n");
        user_blob.push_str(p);
        user_blob.push_str("\n\n");
    }
    if skill_change_full_merge {
        user_blob.push_str("【因能力装载变化须全量并入的较早对话（含 system 提示行）】\n");
    } else {
        user_blob.push_str("【待并入的较早对话片段】\n");
    }
    user_blob.push_str(cold_segment);
    if skill_change_full_merge {
        user_blob.push_str(
            "\n\n请输出更新后的单一整段摘要（简体中文）。\
             上文为能力变更前需一次性折叠的全部历史；请压缩为连贯叙事，不超过约 1000 汉字；勿编造；\
             工具结论注明以当轮系统能力清单为准。",
        );
    } else {
        user_blob.push_str(
            "\n\n请输出更新后的**单一整段**会话摘要（简体中文，连贯叙述即可）。\
             不超过约 1000 汉字；勿编造未出现的对话内容；若涉及工具调用结论，请注明以当轮系统能力清单为准。",
        );
    }

    let sys = if skill_change_full_merge {
        "你是会话压缩助手。用户刚变更了助手的能力装载，需将能力变更前的全部对话折叠为一段摘要，\
以便模型在新能力边界下继续对话。合并输入中的摘要与历史：保留用户目标、事实与未决问题；\
不要编造；不要写死「永久无法使用某能力」—工具与权限以当轮服务端绑定为准。"
    } else {
        "你是会话压缩助手。将输入合并为一段连贯摘要：保留用户目标、约束、已确认事实、未决问题。\
不要编造；不要写死「永久无法使用某能力」—工具与权限以服务端当轮绑定为准。"
    };

    let mut req = CreateChatCompletionRequestArgs::default();
    req.model(DEEPSEEK_MODEL);
    req.messages(vec![
        ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(sys.into()),
            name: None,
        }),
        ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
            content: ChatCompletionRequestUserMessageContent::Text(user_blob),
            name: None,
        }),
    ]);
    let request = req.build().map_err(|e| e.to_string())?;
    let response = client
        .chat()
        .create(request)
        .await
        .map_err(|e| format!("会话摘要生成失败: {e}"))?;
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "摘要模型未返回内容".to_string())?;
    let text = choice.message.content.unwrap_or_default();
    let t = text.trim();
    if t.is_empty() {
        return Err("摘要生成为空".into());
    }
    Ok(truncate_chars_limit(
        t,
        MAX_ROLLING_SUMMARY_CHARS,
    ))
}

#[derive(serde::Serialize)]
pub struct ConversationState {
    pub conversation_id: String,
    pub llm_preset_id: String,
}

#[derive(serde::Serialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
}

async fn ensure_conversation_for_agent(
    pool: &sqlx::SqlitePool,
    agent_id: &str,
) -> Result<ConversationState, String> {
    let cid: Option<String> =
        sqlx::query_scalar("SELECT id FROM conversations WHERE agent_id = ?")
            .bind(agent_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some(conversation_id) = cid {
        let preset: String = sqlx::query_scalar(
            "SELECT llm_preset_id FROM conversations WHERE id = ?",
        )
        .bind(&conversation_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(ConversationState {
            conversation_id,
            llm_preset_id: preset,
        });
    }
    let conversation_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO conversations (id, agent_id, llm_preset_id) VALUES (?, ?, ?)",
    )
    .bind(&conversation_id)
    .bind(agent_id)
    .bind(PRESET_DEEPSEEK)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(ConversationState {
        conversation_id,
        llm_preset_id: PRESET_DEEPSEEK.into(),
    })
}

#[tauri::command]
pub async fn conversations_ensure(
    state: State<'_, HubState>,
    agent_id: String,
) -> Result<ConversationState, String> {
    ensure_conversation_for_agent(&state.pool, &agent_id).await
}

/// 仅写入一条 user 消息（不调大模型），用于能力变更后的显式提醒。
#[tauri::command]
pub async fn messages_append_user_for_agent(
    state: State<'_, HubState>,
    agent_id: String,
    content: String,
) -> Result<(), String> {
    let text = content.trim();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }
    let conv = ensure_conversation_for_agent(&state.pool, &agent_id).await?;
    let mid = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
    )
    .bind(&mid)
    .bind(&conv.conversation_id)
    .bind(text)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn conversations_set_llm_preset(
    state: State<'_, HubState>,
    conversation_id: String,
    llm_preset_id: String,
) -> Result<(), String> {
    if llm_preset_id != PRESET_DEEPSEEK {
        return Err("当前仅支持 DeepSeek（deepseek_default）".into());
    }
    let r = sqlx::query("UPDATE conversations SET llm_preset_id = ? WHERE id = ?")
        .bind(&llm_preset_id)
        .bind(&conversation_id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    if r.rows_affected() == 0 {
        return Err("会话不存在".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn messages_list(
    state: State<'_, HubState>,
    conversation_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let rows = sqlx::query(
        "SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY datetime(created_at) ASC",
    )
    .bind(&conversation_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| ChatMessage {
            id: r.get(0),
            role: r.get(1),
            content: r.get(2),
        })
        .collect())
}

#[tauri::command]
pub async fn chat_send(
    app: AppHandle,
    state: State<'_, HubState>,
    conversation_id: String,
    user_text: String,
) -> Result<String, String> {
    let text = user_text.trim();
    if text.is_empty() {
        return Err("消息不能为空".into());
    }

    let agent_id: String = sqlx::query_scalar(
        "SELECT agent_id FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "会话不存在".to_string())?;

    let preset: String = sqlx::query_scalar(
        "SELECT llm_preset_id FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    if preset != PRESET_DEEPSEEK {
        return Err("不支持的会话大模型预设".into());
    }

    let api_key = hub_load_api_key_for_preset(&preset)?;

    let mut system_prompt: String = sqlx::query_scalar(
        "SELECT system_prompt FROM agents WHERE id = ?",
    )
    .bind(&agent_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let user_msg_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)",
    )
    .bind(&user_msg_id)
    .bind(&conversation_id)
    .bind(text)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    // 本条用户消息已落库，作为「用户发出时间」（服务端视角）。
    let user_message_at: DateTime<Utc> = Utc::now();

    let tools = load_tools(&state.pool, &agent_id).await.map_err(|e| e.to_string())?;
    system_prompt.push_str(BUILTIN_RUNTIME_SYSTEM_SUFFIX);
    system_prompt.push_str(&load_skill_instructions_suffix(&state.pool, &agent_id).await?);
    system_prompt.push_str(&build_capabilities_system_suffix(&tools));

    let cut_id: Option<String> = sqlx::query_scalar(
        "SELECT summary_includes_until_message_id FROM conversations WHERE id = ?",
    )
    .bind(&conversation_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .flatten();

    let conv_row = sqlx::query("SELECT rolling_summary FROM conversations WHERE id = ?")
        .bind(&conversation_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let rolling_prev: Option<String> = conv_row.get(0);

    let loaded: Vec<(String, String, String)> = if let Some(ref cid) = cut_id {
        let cut_ts: Option<String> = sqlx::query_scalar(
            "SELECT datetime(created_at) FROM messages WHERE id = ?",
        )
        .bind(cid)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
        if let Some(ts) = cut_ts {
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, role, content FROM messages WHERE conversation_id = ? \
                 AND datetime(created_at) > datetime(?) ORDER BY datetime(created_at) ASC",
            )
            .bind(&conversation_id)
            .bind(&ts)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| e.to_string())?
        } else {
            sqlx::query_as::<_, (String, String, String)>(
                "SELECT id, role, content FROM messages WHERE conversation_id = ? \
                 ORDER BY datetime(created_at) ASC",
            )
            .bind(&conversation_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| e.to_string())?
        }
    } else {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, role, content FROM messages WHERE conversation_id = ? \
             ORDER BY datetime(created_at) ASC",
        )
        .bind(&conversation_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| e.to_string())?
    };

    let rows: Vec<(String, String)> = loaded
        .iter()
        .map(|(_, role, content)| (role.clone(), content.clone()))
        .collect();
    let split = hot_zone_start_index(&rows, HOT_USER_MESSAGE_COUNT);
    let cold_slice = &loaded[..split];
    let hot_slice = &loaded[split..];
    let full_proxy = estimate_context_proxy_chars(&system_prompt, &rows);

    let cfg = OpenAIConfig::new()
        .with_api_base(DEEPSEEK_BASE)
        .with_api_key(api_key);
    let client = Client::with_config(cfg);

    let mut rolling_for_api: Option<String> = rolling_prev.clone();
    let rolling_nonempty = rolling_prev
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    let need_llm_compress =
        !cold_slice.is_empty() && full_proxy > CONTEXT_CHAR_SOFT_LIMIT;

    let mut use_summary_injection = false;

    if need_llm_compress {
        emit_chat_phase(&app, &conversation_id, "summarizing");
        let cold_pairs: Vec<(String, String)> = cold_slice
            .iter()
            .map(|(_, role, content)| (role.clone(), content.clone()))
            .collect();
        let mut cold_text = format_rows_for_summary_llm(&cold_pairs);
        cold_text = truncate_chars_limit(&cold_text, MAX_COLD_CHARS_FOR_SUMMARY_LLM);
        let fresh = run_conversation_summary_llm(
            &client,
            rolling_prev.as_deref(),
            &cold_text,
            false,
        )
        .await?;
        let last_cold_id: String = cold_slice
            .last()
            .map(|(id, _, _)| id.clone())
            .ok_or_else(|| "冷区为空".to_string())?;
        sqlx::query(
            "UPDATE conversations SET rolling_summary = ?, summary_includes_until_message_id = ?, \
             summary_updated_at = datetime('now') WHERE id = ?",
        )
        .bind(&fresh)
        .bind(&last_cold_id)
        .bind(&conversation_id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
        rolling_for_api = Some(fresh);
        use_summary_injection = true;
    } else if cut_id.is_some() && rolling_nonempty {
        use_summary_injection = true;
    }

    let mut api_messages: Vec<ChatCompletionRequestMessage> = vec![
        ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(system_prompt),
            name: None,
        }),
    ];
    if use_summary_injection {
        if let Some(ref sum) = rolling_for_api {
            let block = format!(
                "{}\n\n{}{}",
                SESSION_SUMMARY_TITLE, sum, SESSION_SUMMARY_GUARD
            );
            api_messages.push(ChatCompletionRequestMessage::System(
                ChatCompletionRequestSystemMessage {
                    content: ChatCompletionRequestSystemMessageContent::Text(block),
                    name: None,
                },
            ));
        }
        if need_llm_compress {
            let hot_pairs: Vec<(String, String)> = hot_slice
                .iter()
                .map(|(_, role, content)| (role.clone(), content.clone()))
                .collect();
            append_history_rows(&mut api_messages, &hot_pairs);
        } else {
            append_history_rows(&mut api_messages, &rows);
        }
    } else {
        append_history_rows(&mut api_messages, &rows);
    }

    let final_text = run_chat_rounds(
        &app,
        &conversation_id,
        &client,
        &state.pool,
        &agent_id,
        &mut api_messages,
        tools,
    )
    .await?;

    let assistant_reply_at: DateTime<Utc> = Utc::now();
    append_dialogue_turn_log(
        &app,
        &conversation_id,
        user_message_at,
        assistant_reply_at,
        text,
        &final_text,
    );

    let asst_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)",
    )
    .bind(&asst_id)
    .bind(&conversation_id)
    .bind(&final_text)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(final_text)
}

/// 在助手保存技能变更后，向该助手全部会话插入一条 system 提示（模型可见）。
pub async fn insert_tools_changed_notices_for_agent(
    pool: &sqlx::SqlitePool,
    agent_id: &str,
) -> Result<(), String> {
    let conv_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM conversations WHERE agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    for cid in conv_ids {
        let mid = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'system', ?)",
        )
        .bind(&mid)
        .bind(&cid)
        .bind(TOOLS_CHANGED_NOTICE)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 保存助手配置且 Skill 已变更后：对该助手每个会话用全文调用摘要 LLM，写入 `rolling_summary` 与 `summary_includes_until_message_id`（Plans/2026041501）。
pub async fn compress_all_conversations_after_skill_change(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &str,
) -> Result<u32, String> {
    let api_key = hub_load_api_key_for_preset(PRESET_DEEPSEEK)?;
    let cfg = OpenAIConfig::new()
        .with_api_base(DEEPSEEK_BASE)
        .with_api_key(api_key);
    let client = Client::with_config(cfg);

    let conv_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM conversations WHERE agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut ok_count: u32 = 0;
    for cid in conv_ids {
        let msg_rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, role, content FROM messages WHERE conversation_id = ? \
             ORDER BY datetime(created_at) ASC",
        )
        .bind(&cid)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
        if msg_rows.is_empty() {
            continue;
        }
        let pairs: Vec<(String, String)> = msg_rows
            .iter()
            .map(|(_, role, content)| (role.clone(), content.clone()))
            .collect();
        let mut cold_text = format_rows_for_summary_llm(&pairs);
        cold_text = truncate_chars_limit(&cold_text, MAX_COLD_CHARS_SKILL_PENDING);
        emit_chat_phase(app, &cid, "summarizing");
        match run_conversation_summary_llm(&client, None, &cold_text, true).await {
            Ok(fresh) => {
                let last_id = msg_rows
                    .last()
                    .map(|(id, _, _)| id.clone())
                    .expect("msg_rows non-empty");
                sqlx::query(
                    "UPDATE conversations SET rolling_summary = ?, \
                     summary_includes_until_message_id = ?, summary_updated_at = datetime('now'), \
                     compression_pending = 0 WHERE id = ?",
                )
                .bind(&fresh)
                .bind(&last_id)
                .bind(&cid)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
                ok_count = ok_count.saturating_add(1);
            }
            Err(e) => {
                log::warn!("会话 {cid} 能力变更后摘要失败: {e}");
            }
        }
    }
    Ok(ok_count)
}

/// 用户保存配置并确认「全量压缩」后由前端调用：执行摘要并发出 `skill_context_compression_done`。
#[tauri::command]
pub async fn compress_conversations_after_skill_change(
    app: AppHandle,
    state: State<'_, HubState>,
    agent_id: String,
) -> Result<u32, String> {
    let n = compress_all_conversations_after_skill_change(&app, &state.pool, &agent_id).await?;
    let _ = app.emit(
        "skill_context_compression_done",
        serde_json::json!({
            "agent_id": agent_id,
            "compressed_conversation_count": n,
        }),
    );
    Ok(n)
}

async fn load_tools(
    pool: &sqlx::SqlitePool,
    agent_id: &str,
) -> Result<Vec<ChatCompletionTool>, String> {
    let rows = sqlx::query(
        "SELECT s.name, s.description, s.parameters_json FROM skills s \
         INNER JOIN agent_skills ak ON ak.skill_id = s.id \
         WHERE ak.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut tools = Vec::new();
    for r in rows {
        let name: String = r.get(0);
        let description: String = r.get(1);
        let params_raw: String = r.get(2);
        let parameters: Value =
            serde_json::from_str(&params_raw).map_err(|e| e.to_string())?;
        tools.push(ChatCompletionTool {
            r#type: ChatCompletionToolType::Function,
            function: FunctionObject {
                name,
                description: Some(description),
                parameters: Some(parameters),
                strict: None,
            },
        });
    }
    Ok(tools)
}

/// 防止模型在未声明工具时仍发起 tool_call：仅当 agent_skills 绑定对应 skill 才允许执行。
async fn agent_allows_tool_by_name(
    pool: &sqlx::SqlitePool,
    agent_id: &str,
    tool_name: &str,
) -> Result<bool, String> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_skills ak \
         INNER JOIN skills s ON s.id = ak.skill_id \
         WHERE ak.agent_id = ? AND s.name = ?",
    )
    .bind(agent_id)
    .bind(tool_name)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// 是否写入按对话分组的本地文本日志 `dialogue-turns.log`（默认开启）。设为 `0` / `false` 可关闭。
fn dialogue_turn_logging_enabled() -> bool {
    std::env::var("AGENT_HUB_LOG_DIALOGUE_TURNS")
        .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false")))
        .unwrap_or(true)
}

/// 一轮「用户消息 → 助手最终回复」以 UTF-8 **追加**到 `app_data_dir/logs/dialogue-turns.log`，格式与 Cursor Skill `conversation-qna-local-log` 的对话组约定一致（含 `<<<QUESTION` / `<<<ANSWER`、时间与耗时）。
///
/// **隐私**：日志含用户与助手正文，请注意磁盘与备份策略。
fn append_dialogue_turn_log(
    app: &AppHandle,
    conversation_id: &str,
    user_at: DateTime<Utc>,
    assistant_at: DateTime<Utc>,
    user_text: &str,
    assistant_text: &str,
) {
    if !dialogue_turn_logging_enabled() {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let log_dir = dir.join("logs");
    if std::fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("dialogue-turns.log");
    let dur_ms = assistant_at.signed_duration_since(user_at).num_milliseconds();
    let secs = (dur_ms as f64 / 1000.0).max(0.0);
    let ut = user_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let at = assistant_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let mut buf = String::new();
    buf.push_str("--------------------------------------------------------------------------------\n");
    buf.push_str("【对话组】\n");
    buf.push_str(&format!("会话 ID: {conversation_id}\n"));
    buf.push_str(&format!("用户发出时间: {ut}\n"));
    buf.push_str(&format!("助手返回时间: {at}\n"));
    buf.push_str(&format!("助手耗时（秒）: {secs:.3}\n\n"));
    buf.push_str("<<<QUESTION\n");
    buf.push_str(user_text);
    if !user_text.ends_with('\n') {
        buf.push('\n');
    }
    buf.push_str(">>>\n\n");
    buf.push_str("<<<ANSWER\n");
    buf.push_str(assistant_text);
    if !assistant_text.ends_with('\n') {
        buf.push('\n');
    }
    buf.push_str(">>>\n\n");

    if let Err(e) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(buf.as_bytes()))
    {
        log::warn!("写入 dialogue-turns.log 失败: {e}");
    }
}

/// 开发调试：将每轮 `chat.completions` 请求体序列化为 JSON，经 `log::info` 输出（debug 下配合 `tauri-plugin-log` 可在终端看到），并**追加**到 `app_data_dir/logs/chat-requests.jsonl`（每行一条 JSON）。
///
/// **启用条件**：`cfg!(debug_assertions)`，或环境变量 `AGENT_HUB_LOG_CHAT_REQUEST=1` / `true`（便于 release 临时抓包）。  
/// **注意**：请求含完整对话与 system，可能含用户隐私；勿在公共环境长期开启。  
/// **分工**：按「轮次」抓包见本函数；按「用户一条 ↔ 助手一条」的对话组见 `append_dialogue_turn_log` 与 `dialogue-turns.log`。
fn log_chat_completion_request_dev(
    app: &AppHandle,
    conversation_id: &str,
    tool_round: u8,
    request: &CreateChatCompletionRequest,
) {
    let enabled = cfg!(debug_assertions)
        || std::env::var("AGENT_HUB_LOG_CHAT_REQUEST")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    if !enabled {
        return;
    }

    let req_val = match serde_json::to_value(request) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("chat completion request JSON 序列化失败: {e}");
            return;
        }
    };
    let envelope = serde_json::json!({
        "conversation_id": conversation_id,
        "tool_round": tool_round,
        "request": req_val,
    });
    let pretty = match serde_json::to_string_pretty(&envelope) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("chat completion envelope JSON 序列化失败: {e}");
            return;
        }
    };
    log::info!("OpenAI ChatCompletions 请求 JSON（开发/调试）:\n{pretty}");

    if let Ok(dir) = app.path().app_data_dir() {
        let log_dir = dir.join("logs");
        if std::fs::create_dir_all(&log_dir).is_ok() {
            let path = log_dir.join("chat-requests.jsonl");
            if let Ok(mut line) = serde_json::to_string(&envelope) {
                line.push('\n');
                if let Err(e) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .and_then(|mut f| f.write_all(line.as_bytes()))
                {
                    log::warn!("写入 chat-requests.jsonl 失败: {e}");
                }
            }
        }
    }
}

async fn run_chat_rounds(
    app: &AppHandle,
    conversation_id: &str,
    client: &Client<OpenAIConfig>,
    pool: &sqlx::SqlitePool,
    from_agent_id: &str,
    api_messages: &mut Vec<ChatCompletionRequestMessage>,
    tools: Vec<ChatCompletionTool>,
) -> Result<String, String> {
    for round in 0..8_u8 {
        let phase = if round == 0 {
            "thinking"
        } else {
            "analyzing"
        };
        emit_chat_phase(app, conversation_id, phase);

        let mut req = CreateChatCompletionRequestArgs::default();
        req.model(DEEPSEEK_MODEL);
        req.messages(api_messages.clone());
        if !tools.is_empty() {
            req.tools(tools.clone());
        }
        let request = req.build().map_err(|e| e.to_string())?;
        log_chat_completion_request_dev(app, conversation_id, round, &request);

        let response = client
            .chat()
            .create(request)
            .await
            .map_err(|e| format!("大模型请求失败: {e}"))?;

        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| "大模型未返回内容".to_string())?;

        let finish_reason = choice.finish_reason;
        let msg = choice.message;

        if let Some(ref tcs) = msg.tool_calls {
            if !tcs.is_empty() {
                api_messages.push(assistant_for_tool_round(&msg)?);
                for tc in tcs {
                    let out = dispatch_tool(pool, from_agent_id, tc).await;
                    api_messages.push(ChatCompletionRequestMessage::Tool(
                        ChatCompletionRequestToolMessage {
                            content: ChatCompletionRequestToolMessageContent::Text(out),
                            tool_call_id: tc.id.clone(),
                        },
                    ));
                }
                continue;
            }
        }

        if let Some(t) = msg.content.filter(|s| !s.trim().is_empty()) {
            emit_chat_phase(app, conversation_id, "generating");
            return Ok(t);
        }

        if matches!(finish_reason, Some(FinishReason::Stop)) {
            return Ok(String::new());
        }

        return Err("大模型返回空内容".into());
    }
    Err("工具调用轮次过多，已中止".into())
}

fn assistant_for_tool_round(msg: &ChatCompletionResponseMessage) -> Result<ChatCompletionRequestMessage, String> {
    let content = msg
        .content
        .clone()
        .map(ChatCompletionRequestAssistantMessageContent::Text);
    Ok(ChatCompletionRequestMessage::Assistant(
        ChatCompletionRequestAssistantMessage {
            content,
            tool_calls: msg.tool_calls.clone(),
            ..Default::default()
        },
    ))
}

async fn dispatch_tool(
    pool: &sqlx::SqlitePool,
    from_agent_id: &str,
    tc: &ChatCompletionMessageToolCall,
) -> String {
    let name = tc.function.name.as_str();
    let args_raw = tc.function.arguments.trim();

    match agent_allows_tool_by_name(pool, from_agent_id, name).await {
        Ok(false) => {
            return format!(
                "当前助手未装载该能力（{name}），已拒绝执行。请在「配置助手」中装载对应能力后再试。"
            );
        }
        Err(e) => return format!("校验工具权限失败: {e}"),
        Ok(true) => {}
    }

    let Ok(args): Result<Value, _> = serde_json::from_str(args_raw) else {
        return format!("处理工具「{name}」失败: 参数不是合法 JSON");
    };

    skill_dispatch::invoke_builtin(pool, from_agent_id, name, &args).await
}

/// 已绑定 Skill 的 L2（`instructions_md`）拼块；**不**写入 `messages` 表（[Plans/2026041202/03]）。
async fn load_skill_instructions_suffix(
    pool: &sqlx::SqlitePool,
    agent_id: &str,
) -> Result<String, String> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT COALESCE(NULLIF(TRIM(s.display_name), ''), s.name), s.instructions_md \
         FROM skills s \
         INNER JOIN agent_skills ak ON ak.skill_id = s.id \
         WHERE ak.agent_id = ?",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut out = String::new();
    for (display_name, md) in rows {
        let t = md.trim();
        if t.is_empty() {
            continue;
        }
        let body = truncate_chars_for_system(t, SKILL_INSTRUCTIONS_MAX_CHARS);
        out.push_str("\n\n【能力指导：");
        out.push_str(&display_name);
        out.push_str("】\n");
        out.push_str(&body);
    }
    Ok(out)
}
