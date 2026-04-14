-- 长对话冷区滚动摘要 + Skill 装载变更触发的待压缩标记（Plans/2026041501）
ALTER TABLE conversations ADD COLUMN rolling_summary TEXT;
ALTER TABLE conversations ADD COLUMN summary_updated_at TEXT;
ALTER TABLE conversations ADD COLUMN compression_pending INTEGER NOT NULL DEFAULT 0;
