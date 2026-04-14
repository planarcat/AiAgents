-- 能力展示名：查看已装载能力 → 查看可用能力
UPDATE skills
SET display_name = '查看可用能力'
WHERE id = 'skill-builtin-list-loaded-skills';
