//! 本地 Agent 配置（SQLite）；与默认模板 / 首装同源逻辑。

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;
use uuid::Uuid;

use std::collections::HashSet;

use super::chat::insert_tools_changed_notices_for_agent;
use super::skills::{
    merge_and_validate_skill_ids, replace_agent_skills, replace_agent_skills_tx,
};
use super::HubState;

#[allow(dead_code)]
pub const SKILL_DELEGATE_ID: &str = "skill-builtin-delegate";

/// 与首装、默认模板按钮共用的人设（Plans/2026040402）
pub const DEFAULT_TEMPLATE_DISPLAY_NAME: &str = "助手";
pub const DEFAULT_TEMPLATE_SYSTEM_PROMPT: &str = r#"你是用户身边的智能助手。当用户提出需求时，如实作答。诚实与工具边界由系统每轮内置说明约束。
当确有需要由其他助手协作且已在左侧装载「事务委派」能力时，可使用 request_agent_help；若委派不可用，请向用户说明原因。"#;

#[derive(serde::Serialize)]
pub struct AgentSummary {
    pub id: String,
    pub display_name: String,
    pub allows_outgoing_delegation: bool,
    pub accepts_incoming_delegation: bool,
}

/// [`agents_update`] 返回值：前端据此决定是否在保存后提示「全量压缩上下文」。
#[derive(serde::Serialize)]
pub struct AgentUpdateResult {
    pub skills_changed: bool,
}

#[derive(serde::Serialize)]
pub struct AgentDetail {
    pub id: String,
    pub display_name: String,
    pub system_prompt: String,
    pub allows_outgoing_delegation: bool,
    pub accepts_incoming_delegation: bool,
    /// 已绑定的能力 id。
    pub skill_ids: Vec<String>,
}

/// 首装方案 B：`app_meta` + 与默认模板相同的 `create_agent` 路径（Plans/2026040402 §2）。
pub async fn ensure_first_default_template(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let flag: Option<String> = sqlx::query_scalar(
        "SELECT value FROM app_meta WHERE key = 'first_default_template_applied'",
    )
    .fetch_optional(pool)
    .await?;
    if flag.as_deref() == Some("1") {
        return Ok(());
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM agents")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        sqlx::query(
            "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('first_default_template_applied', '1')",
        )
        .execute(pool)
        .await?;
        return Ok(());
    }

    let merged = merge_and_validate_skill_ids(pool, &[]).await.map_err(|e| {
        sqlx::Error::Configuration(format!("skills: {e}").into())
    })?;
    let allows_out = merged.iter().any(|s| s == SKILL_DELEGATE_ID);
    let mut tx = pool.begin().await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, ?, 1)"#,
    )
    .bind(&id)
    .bind(DEFAULT_TEMPLATE_DISPLAY_NAME)
    .bind(DEFAULT_TEMPLATE_SYSTEM_PROMPT)
    .bind(if allows_out { 1i64 } else { 0 })
    .execute(tx.as_mut())
    .await?;
    replace_agent_skills_tx(&mut tx, &id, &merged)
        .await
        .map_err(|e| sqlx::Error::Configuration(e.into()))?;
    sqlx::query(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('first_default_template_applied', '1')",
    )
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(())
}

#[tauri::command]
pub async fn agents_list(state: State<'_, HubState>) -> Result<Vec<AgentSummary>, String> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        r#"SELECT a.id, a.display_name,
          CASE WHEN EXISTS (
            SELECT 1 FROM agent_skills s WHERE s.agent_id = a.id AND s.skill_id = ?
          ) THEN 1 ELSE 0 END,
          a.accepts_incoming_delegation
         FROM agents a ORDER BY datetime(a.created_at) ASC"#,
    )
    .bind(SKILL_DELEGATE_ID)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, display_name, ao, ai)| AgentSummary {
            id,
            display_name,
            allows_outgoing_delegation: ao != 0,
            accepts_incoming_delegation: ai != 0,
        })
        .collect())
}

#[tauri::command]
pub async fn agents_get(state: State<'_, HubState>, id: String) -> Result<AgentDetail, String> {
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, display_name, system_prompt, accepts_incoming_delegation \
         FROM agents WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((id, display_name, system_prompt, ai)) = row else {
        return Err("助手不存在".into());
    };
    let skill_ids: Vec<String> = sqlx::query_scalar(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY skill_id ASC",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let allows_out = skill_ids.iter().any(|s| s == SKILL_DELEGATE_ID);
    Ok(AgentDetail {
        id,
        display_name,
        system_prompt,
        allows_outgoing_delegation: allows_out,
        accepts_incoming_delegation: ai != 0,
        skill_ids,
    })
}

#[tauri::command]
pub async fn agents_create(
    state: State<'_, HubState>,
    display_name: String,
    system_prompt: String,
    skill_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("名称不能为空".into());
    }
    let id = Uuid::new_v4().to_string();
    let prompt = system_prompt.trim();
    let prompt = if prompt.is_empty() {
        "你是一个有帮助的助手。"
    } else {
        prompt
    };
    let user_skills: Vec<String> = skill_ids.unwrap_or_default();
    let merged = merge_and_validate_skill_ids(&state.pool, &user_skills).await?;
    let allows_out = merged.iter().any(|s| s == SKILL_DELEGATE_ID);

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, ?, 1)"#,
    )
    .bind(&id)
    .bind(display_name)
    .bind(prompt)
    .bind(if allows_out { 1i64 } else { 0 })
    .execute(tx.as_mut())
    .await
    .map_err(|e| e.to_string())?;
    replace_agent_skills_tx(&mut tx, &id, &merged).await?;
    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(id)
}

/// 与首装、内部 `ensure_first_default_template` 使用相同默认文案与必要 Skills。
#[tauri::command]
pub async fn agents_create_default_template(state: State<'_, HubState>) -> Result<String, String> {
    let merged = merge_and_validate_skill_ids(&state.pool, &[]).await?;
    let allows_out = merged.iter().any(|s| s == SKILL_DELEGATE_ID);
    let id = Uuid::new_v4().to_string();
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, ?, 1)"#,
    )
    .bind(&id)
    .bind(DEFAULT_TEMPLATE_DISPLAY_NAME)
    .bind(DEFAULT_TEMPLATE_SYSTEM_PROMPT)
    .bind(if allows_out { 1i64 } else { 0 })
    .execute(tx.as_mut())
    .await
    .map_err(|e| e.to_string())?;
    replace_agent_skills_tx(&mut tx, &id, &merged).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub async fn agents_delete(state: State<'_, HubState>, id: String) -> Result<(), String> {
    let r = sqlx::query("DELETE FROM agents WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    if r.rows_affected() == 0 {
        return Err("助手不存在".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn agents_update(
    state: State<'_, HubState>,
    id: String,
    display_name: String,
    system_prompt: String,
    accepts_incoming_delegation: bool,
    skill_ids: Vec<String>,
) -> Result<AgentUpdateResult, String> {
    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err("名称不能为空".into());
    }
    let prompt = system_prompt.trim();
    let prompt = if prompt.is_empty() {
        "你是一个有帮助的助手。"
    } else {
        prompt
    };
    let merged = merge_and_validate_skill_ids(&state.pool, &skill_ids).await?;
    let allows_out = merged.iter().any(|s| s == SKILL_DELEGATE_ID);

    let old_skills: Vec<String> = sqlx::query_scalar(
        "SELECT skill_id FROM agent_skills WHERE agent_id = ? ORDER BY skill_id",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let old_set: HashSet<String> = old_skills.into_iter().collect();
    let new_set: HashSet<String> = merged.iter().cloned().collect();
    let skills_changed = old_set != new_set;

    let r = sqlx::query(
        "UPDATE agents SET display_name = ?, system_prompt = ?, allows_outgoing_delegation = ?, accepts_incoming_delegation = ? WHERE id = ?",
    )
    .bind(display_name)
    .bind(prompt)
    .bind(if allows_out { 1i64 } else { 0 })
    .bind(if accepts_incoming_delegation { 1i64 } else { 0 })
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    if r.rows_affected() == 0 {
        return Err("助手不存在".into());
    }
    replace_agent_skills(&state.pool, &id, &merged).await?;
    if skills_changed {
        insert_tools_changed_notices_for_agent(&state.pool, &id).await?;
    }
    Ok(AgentUpdateResult { skills_changed })
}

#[derive(Deserialize)]
struct AgentImportItem {
    display_name: String,
    system_prompt: Option<String>,
}

/// JSON 数组：`[{ "display_name": "...", "system_prompt": "..." }]`
#[tauri::command]
pub async fn agents_import_bulk(state: State<'_, HubState>, json: String) -> Result<u32, String> {
    let items: Vec<AgentImportItem> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if items.is_empty() {
        return Err("文件中没有可导入的助手".into());
    }

    let merged = merge_and_validate_skill_ids(&state.pool, &[]).await?;
    let allows_out = merged.iter().any(|s| s == SKILL_DELEGATE_ID);
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let mut n: u32 = 0;
    for item in items {
        let name = item.display_name.trim();
        if name.is_empty() {
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let prompt = item
            .system_prompt
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();
        let prompt = if prompt.is_empty() {
            "你是一个有帮助的助手。".to_string()
        } else {
            prompt
        };
        sqlx::query(
            r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
            VALUES (?, ?, ?, ?, 1)"#,
        )
        .bind(&id)
        .bind(name)
        .bind(&prompt)
        .bind(if allows_out { 1i64 } else { 0 })
        .execute(tx.as_mut())
        .await
        .map_err(|e| e.to_string())?;
        replace_agent_skills_tx(&mut tx, &id, &merged).await?;
        n += 1;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(n)
}
