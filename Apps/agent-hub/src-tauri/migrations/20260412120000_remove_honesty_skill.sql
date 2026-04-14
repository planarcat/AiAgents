-- 诚实与边界已改为每轮内置 system，不再作为 skills 表中的 Tool。
DELETE FROM agent_skills WHERE skill_id = 'skill-builtin-honesty';
DELETE FROM skills WHERE id = 'skill-builtin-honesty';
