-- 会话摘要已覆盖到哪条 message（含该 id）；之后的消息仍以原文进入模型（Plans/2026041501 保存时全量压缩）
ALTER TABLE conversations ADD COLUMN summary_includes_until_message_id TEXT;
