-- Hub 初始库结构（Plans/2026040401 §3.4 后续随里程碑补全）
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
