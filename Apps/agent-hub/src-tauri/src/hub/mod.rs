//! 集中式 Hub：持久化、LLM、MCP、委派（随里程碑扩展）。

pub mod agents;
pub mod settings;

// 占位：M3 MCP 接入时使用；避免被 Cargo 视为未使用依赖（版本随 Plan §2.1）。
use rmcp as _;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tauri::{AppHandle, Manager, State};

const DB_FILE: &str = "agent-hub.db";

pub struct HubState {
    pub pool: sqlx::SqlitePool,
}

/// 应用启动时初始化 SQLite 与迁移。
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join(DB_FILE);
    // Windows 下手写 `sqlite:…` URL 易触发 SQLITE_CANTOPEN(14)；用 filename + create_if_missing 更稳。
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    let pool = tauri::async_runtime::block_on(async {
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok::<_, sqlx::Error>(pool)
    })?;

    app.manage(HubState { pool });
    log::info!("Hub SQLite ready at {}", db_path.display());
    Ok(())
}

#[tauri::command]
pub fn hub_health() -> &'static str {
    "hub:ok"
}

#[tauri::command]
pub async fn hub_db_ping(state: State<'_, HubState>) -> Result<String, String> {
    sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok("db:ok".into())
}
