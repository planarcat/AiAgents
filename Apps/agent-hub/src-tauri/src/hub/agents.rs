//! 本地 Agent 配置（SQLite）。

use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use super::HubState;

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct AgentSummary {
    pub id: String,
    pub display_name: String,
}

#[tauri::command]
pub async fn agents_list(state: State<'_, HubState>) -> Result<Vec<AgentSummary>, String> {
    sqlx::query_as::<_, AgentSummary>(
        "SELECT id, display_name FROM agents ORDER BY datetime(created_at) ASC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())
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

    sqlx::query(r#"INSERT INTO agents (id, display_name, system_prompt) VALUES (?, ?, ?)"#)
        .bind(&id)
        .bind(display_name)
        .bind(prompt)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(id)
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
        sqlx::query(r#"INSERT INTO agents (id, display_name, system_prompt) VALUES (?, ?, ?)"#)
            .bind(&id)
            .bind(name)
            .bind(&prompt)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        n += 1;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(n)
}
