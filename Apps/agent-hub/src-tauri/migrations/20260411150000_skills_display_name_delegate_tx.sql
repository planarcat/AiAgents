-- 展示名调整：助手间委派 → 事务委派（已执行过 display_name 迁移的库）
UPDATE skills SET display_name = '事务委派' WHERE id = 'skill-builtin-delegate';
