//! 本地 Agent 配置（SQLite）；与默认模板 / 首装同源逻辑。

use serde::Deserialize;
use sqlx::SqlitePool;
use tauri::State;
use uuid::Uuid;

use super::HubState;

pub const SKILL_DELEGATE_ID: &str = "skill-builtin-delegate";
pub const SKILL_HONESTY_ID: &str = "skill-builtin-honesty";

/// 与首装、默认模板按钮共用的人设（Plans/2026040402）
pub const DEFAULT_TEMPLATE_DISPLAY_NAME: &str = "助手";
pub const DEFAULT_TEMPLATE_SYSTEM_PROMPT: &str = r#"你是用户身边的智能助手。当用户提出需求时，如实作答；若你无法可靠完成（缺信息、缺权限、超出能力），请先使用 honesty_acknowledge 说明限制，不要编造。
当确有需要由其他助手协作且当前策略允许委派时，可使用 request_agent_help；若委派不可用，请向用户说明原因。"#;

#[derive(serde::Serialize)]
pub struct AgentSummary {
    pub id: String,
    pub display_name: String,
    pub allows_outgoing_delegation: bool,
    pub accepts_incoming_delegation: bool,
}

#[derive(serde::Serialize)]
pub struct AgentDetail {
    pub id: String,
    pub display_name: String,
    pub system_prompt: String,
    pub allows_outgoing_delegation: bool,
    pub accepts_incoming_delegation: bool,
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

    let mut tx = pool.begin().await?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, 1, 1)"#,
    )
    .bind(&id)
    .bind(DEFAULT_TEMPLATE_DISPLAY_NAME)
    .bind(DEFAULT_TEMPLATE_SYSTEM_PROMPT)
    .execute(tx.as_mut())
    .await?;
    attach_necessary_skills_tx(&mut tx, &id).await?;
    sqlx::query(
        "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('first_default_template_applied', '1')",
    )
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn attach_necessary_skills_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    agent_id: &str,
) -> Result<(), sqlx::Error> {
    use sqlx::Acquire;
    let conn = tx.acquire().await?;
    for sid in [SKILL_DELEGATE_ID, SKILL_HONESTY_ID] {
        sqlx::query("INSERT OR IGNORE INTO agent_skills (agent_id, skill_id) VALUES (?, ?)")
            .bind(agent_id)
            .bind(sid)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn agents_list(state: State<'_, HubState>) -> Result<Vec<AgentSummary>, String> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, display_name, allows_outgoing_delegation, accepts_incoming_delegation \
         FROM agents ORDER BY datetime(created_at) ASC",
    )
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
    let row: Option<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation \
         FROM agents WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((id, display_name, system_prompt, ao, ai)) = row else {
        return Err("助手不存在".into());
    };
    Ok(AgentDetail {
        id,
        display_name,
        system_prompt,
        allows_outgoing_delegation: ao != 0,
        accepts_incoming_delegation: ai != 0,
    })
}

#[tauri::command]
pub async fn agents_create(
    state: State<'_, HubState>,
    display_name: String,
    system_prompt: String,
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

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, 1, 1)"#,
    )
    .bind(&id)
    .bind(display_name)
    .bind(prompt)
    .execute(tx.as_mut())
    .await
    .map_err(|e| e.to_string())?;
    attach_necessary_skills_tx(&mut tx, &id)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(id)
}

/// 与首装、内部 `ensure_first_default_template` 使用相同默认文案与必要 Skills。
#[tauri::command]
pub async fn agents_create_default_template(state: State<'_, HubState>) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        r#"INSERT INTO agents (id, display_name, system_prompt, allows_outgoing_delegation, accepts_incoming_delegation)
        VALUES (?, ?, ?, 1, 1)"#,
    )
    .bind(&id)
    .bind(DEFAULT_TEMPLATE_DISPLAY_NAME)
    .bind(DEFAULT_TEMPLATE_SYSTEM_PROMPT)
    .execute(tx.as_mut())
    .await
    .map_err(|e| e.to_string())?;
    attach_necessary_skills_tx(&mut tx, &id)
        .await
        .map_err(|e| e.to_string())?;
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
    allows_outgoing_delegation: bool,
    accepts_incoming_delegation: bool,
) -> Result<(), String> {
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
    let r = sqlx::query(
        "UPDATE agents SET display_name = ?, system_prompt = ?, allows_outgoing_delegation = ?, accepts_incoming_delegation = ? WHERE id = ?",
    )
    .bind(display_name)
    .bind(prompt)
    .bind(if allows_outgoing_delegation { 1i64 } else { 0 })
    .bind(if accepts_incoming_delegation { 1i64 } else { 0 })
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    if r.rows_affected() == 0 {
        return Err("助手不存在".into());
    }
    Ok(())
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
            VALUES (?, ?, ?, 1, 1)"#,
        )
        .bind(&id)
        .bind(name)
        .bind(&prompt)
        .execute(tx.as_mut())
        .await
        .map_err(|e| e.to_string())?;
        attach_necessary_skills_tx(&mut tx, &id)
            .await
            .map_err(|e| e.to_string())?;
        n += 1;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(n)
}
