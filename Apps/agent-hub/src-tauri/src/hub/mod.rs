//! 集中式 Hub：持久化、LLM、MCP、委派（随里程碑扩展）。

pub mod agents;
pub mod chat;
pub mod settings;

// 占位：M3 MCP 接入时使用；避免被 Cargo 视为未使用依赖（版本随 Plan §2.1）。
use rmcp as _;

use sha2::{Digest, Sha384};
use sqlx::migrate::MigrateError;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Error as SqlxError, SqlitePool};
use tauri::{AppHandle, Manager, State};

const DB_FILE: &str = "agent-hub.db";

/// sqlx 以 **SHA384(迁移文件 UTF-8 字节)** 存校验和。开发中若改过已应用的 `.sql`，会触发
/// `VersionMismatch`；此处按磁盘内容写回 `_sqlx_migrations`，避免只能删库（与 `sqlx migrate repair` 等效）。
async fn sync_sqlx_checksums_from_disk(pool: &SqlitePool) -> Result<(), SqlxError> {
    let mig_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut entries: Vec<_> = std::fs::read_dir(&mig_dir)
        .map_err(|e| SqlxError::Configuration(e.into()))?
        .filter_map(|e| e.ok())
        .collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("sql") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| SqlxError::Configuration("invalid migration file name".into()))?;
        let version_str = stem
            .split('_')
            .next()
            .ok_or_else(|| SqlxError::Configuration("invalid migration file name".into()))?;
        let version: i64 = version_str
            .parse::<i64>()
            .map_err(|e| SqlxError::Configuration(e.into()))?;
        let sql = std::fs::read_to_string(&path)
            .map_err(|e| SqlxError::Configuration(e.into()))?;
        let checksum = Sha384::digest(sql.as_bytes());
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(checksum.as_slice())
            .bind(version)
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn run_migrations_or_repair_checksums(pool: &SqlitePool) -> Result<(), SqlxError> {
    match sqlx::migrate!("./migrations").run(pool).await {
        Ok(()) => Ok(()),
        Err(MigrateError::VersionMismatch(_)) => {
            log::warn!(
                "迁移文件校验和与数据库不一致，已按 `src-tauri/migrations` 同步 `_sqlx_migrations` 后重试"
            );
            sync_sqlx_checksums_from_disk(pool).await?;
            sqlx::migrate!("./migrations")
                .run(pool)
                .await
                .map_err(SqlxError::from)
        }
        Err(e) => Err(SqlxError::from(e)),
    }
}

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
            .after_connect(|conn, _| {
                Box::pin(async move {
                    use sqlx::Executor;
                    conn.execute("PRAGMA foreign_keys = ON").await?;
                    Ok(())
                })
            })
            .connect_with(opts)
            .await?;
        run_migrations_or_repair_checksums(&pool).await?;
        agents::ensure_first_default_template(&pool).await?;
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
