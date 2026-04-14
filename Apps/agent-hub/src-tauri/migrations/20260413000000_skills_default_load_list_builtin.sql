-- 默认装载能力（不可卸载）+ 内置「查看可用能力」工具
ALTER TABLE skills ADD COLUMN is_default_load INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO skills (
  id, builtin_code, name, description, parameters_json, handler,
  display_name, instructions_md, kind, is_default_load
) VALUES (
  'skill-builtin-list-loaded-skills',
  'list_loaded_skills',
  'list_my_loaded_skills',
  '当用户询问你有哪些能力、当前已装载哪些技能、能否列出你的工具等时调用。返回本助手当前已装载的全部能力及说明（工具名、描述、类型等）。',
  '{"type":"object","properties":{},"additionalProperties":false}',
  'builtin',
  '查看可用能力',
  '用户明确询问「有哪些能力」「列出你的技能」「当前装载了什么」等时调用；调用后根据返回的结构化列表用自然语言向用户说明。勿在用户未问及能力清单时主动调用。',
  'builtin_static',
  1
);

INSERT OR IGNORE INTO agent_skills (agent_id, skill_id)
SELECT id, 'skill-builtin-list-loaded-skills' FROM agents;
