//! 能力目录（skills 表）与助手绑定校验。
//! 与 `agents::SKILL_*` 同值，避免 `agents` ↔ `skills` 模块循环依赖。

use serde::Serialize;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use std::collections::HashSet;
use tauri::State;

use super::HubState;

#[derive(Serialize)]
pub struct SkillCatalogItem {
    pub id: String,
    /// OpenAI 工具函数名（与 `skills.name` 一致，供模型调用）
    pub tool_name: String,
    /// 界面展示名称（`skills.display_name`，空则回退为 `name`）
    pub display_name: String,
    pub description: String,
    /// `builtin_static` / `builtin_config` / …（见 Plans/2026041202）
    pub kind: String,
    /// 必选/默认装载：合并保存时始终包含，界面不可卸下。
    pub is_default_load: bool,
}

#[tauri::command]
pub async fn skills_catalog(state: State<'_, HubState>) -> Result<Vec<SkillCatalogItem>, String> {
    let rows = sqlx::query(
        "SELECT id, name, description, display_name, kind, is_default_load FROM skills \
         ORDER BY COALESCE(NULLIF(TRIM(display_name), ''), name) ASC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let id: String = r.get(0);
            let tool_name: String = r.get(1);
            let description: String = r.get(2);
            let display_name_raw: String = r.get(3);
            let kind: String = r.get(4);
            let is_default_load: i64 = r.get(5);
            let display_name = {
                let t = display_name_raw.trim();
                if t.is_empty() {
                    tool_name.clone()
                } else {
                    t.to_string()
                }
            };
            SkillCatalogItem {
                id,
                tool_name,
                display_name,
                description,
                kind,
                is_default_load: is_default_load != 0,
            }
        })
        .collect())
}

/// 合并「默认装载」能力 id，去重并校验均在 `skills` 表中存在。
pub async fn merge_and_validate_skill_ids(
    pool: &SqlitePool,
    user_selection: &[String],
) -> Result<Vec<String>, String> {
    let default_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM skills WHERE is_default_load = 1 ORDER BY id ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for id in default_ids {
        if seen.insert(id.clone()) {
            merged.push(id);
        }
    }
    for id in user_selection {
        if seen.insert(id.clone()) {
            merged.push(id.clone());
        }
    }

    for sid in &merged {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM skills WHERE id = ?")
            .bind(sid)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())?;
        if n != 1 {
            return Err(format!("无效的能力 id: {sid}"));
        }
    }
    Ok(merged)
}

pub async fn replace_agent_skills_tx(
    tx: &mut Transaction<'_, Sqlite>,
    agent_id: &str,
    skill_ids: &[String],
) -> Result<(), String> {
    sqlx::query("DELETE FROM agent_skills WHERE agent_id = ?")
        .bind(agent_id)
        .execute(tx.as_mut())
        .await
        .map_err(|e| e.to_string())?;
    for sid in skill_ids {
        sqlx::query("INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)")
            .bind(agent_id)
            .bind(sid)
            .execute(tx.as_mut())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn replace_agent_skills(
    pool: &SqlitePool,
    agent_id: &str,
    skill_ids: &[String],
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    replace_agent_skills_tx(&mut tx, agent_id, skill_ids).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}
