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
        CreateChatCompletionRequestArgs, FinishReason, FunctionObject,
    },
    Client,
};
use serde_json::Value;
use sqlx::Row;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use super::settings::hub_load_api_key_for_preset;
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

#[tauri::command]
pub async fn conversations_ensure(
    state: State<'_, HubState>,
    agent_id: String,
) -> Result<ConversationState, String> {
    let cid: Option<String> =
        sqlx::query_scalar("SELECT id FROM conversations WHERE agent_id = ?")
            .bind(&agent_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| e.to_string())?;
    if let Some(conversation_id) = cid {
        let preset: String = sqlx::query_scalar(
            "SELECT llm_preset_id FROM conversations WHERE id = ?",
        )
        .bind(&conversation_id)
        .fetch_one(&state.pool)
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
    .bind(&agent_id)
    .bind(PRESET_DEEPSEEK)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(ConversationState {
        conversation_id,
        llm_preset_id: PRESET_DEEPSEEK.into(),
    })
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

    let system_prompt: String = sqlx::query_scalar(
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

    let tools = load_tools(&state.pool, &agent_id).await.map_err(|e| e.to_string())?;

    let history_rows = sqlx::query(
        "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY datetime(created_at) ASC",
    )
    .bind(&conversation_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut api_messages: Vec<ChatCompletionRequestMessage> = vec![
        ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(system_prompt),
            name: None,
        }),
    ];
    for r in history_rows {
        let role: String = r.get(0);
        let content: String = r.get(1);
        match role.as_str() {
            "user" => api_messages.push(ChatCompletionRequestMessage::User(
                ChatCompletionRequestUserMessage {
                    content: ChatCompletionRequestUserMessageContent::Text(content),
                    name: None,
                },
            )),
            "assistant" => api_messages.push(ChatCompletionRequestMessage::Assistant(
                ChatCompletionRequestAssistantMessage {
                    content: Some(ChatCompletionRequestAssistantMessageContent::Text(
                        content,
                    )),
                    ..Default::default()
                },
            )),
            _ => {}
        }
    }

    let cfg = OpenAIConfig::new()
        .with_api_base(DEEPSEEK_BASE)
        .with_api_key(api_key);
    let client = Client::with_config(cfg);

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
    let Ok(args): Result<Value, _> = serde_json::from_str(args_raw) else {
        return format!("处理工具「{name}」失败: 参数不是合法 JSON");
    };

    match name {
        "honesty_acknowledge" => handle_honesty(&args),
        "request_agent_help" => handle_delegate(pool, from_agent_id, &args).await,
        _ => format!("未知工具: {name}"),
    }
}

fn handle_honesty(args: &Value) -> String {
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("(未说明)");
    format!("（已记录）助手声明限制 / 无法完成: {reason}")
    // 纯提示档：轻量固定模板，供模型在后续轮次引用。
}

async fn handle_delegate(pool: &sqlx::SqlitePool, from_agent_id: &str, args: &Value) -> String {
    let Some(to) = args.get("to_agent_id").and_then(|v| v.as_str()) else {
        return "委派失败: 缺少 to_agent_id".into();
    };
    let intent = args
        .get("intent")
        .and_then(|v| v.as_str())
        .unwrap_or("(未提供意图)");

    let from_allow: Option<i64> =
        sqlx::query_scalar("SELECT allows_outgoing_delegation FROM agents WHERE id = ?")
            .bind(from_agent_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let Some(1) = from_allow else {
        return format!(
            "委派失败: 当前助手未允许向外委派（intent: {intent}）。请在编辑助手中开启「如需其他助手辅助时是否允许委派」。"
        );
    };

    let target: Option<(i64, String)> = sqlx::query_as(
        "SELECT accepts_incoming_delegation, display_name FROM agents WHERE id = ?",
    )
    .bind(to)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let Some((acc, tname)) = target else {
        return format!("委派失败: 目标助手不存在（to_agent_id={to}）。intent: {intent}");
    };
    if acc != 1 {
        return format!(
            "委派失败: 助手「{tname}」不接受入站委派。intent: {intent}"
        );
    }

    if to == from_agent_id {
        return format!("委派失败: 不能委派给自己。intent: {intent}");
    }

    // M4 前无真实 Hub 子任务；明确告知模型与用户态，避免捏造成功。
    format!(
        "（MVP 提示）委派请求已被记录：自 {from_agent_id} → {to}（{tname}），意图: {intent}。端到端 Hub 子任务将在 M4 落地；当前请勿声称对方已实际执行完成。"
    )
}
