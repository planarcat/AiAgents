-- 界面展示用能力名称（skills.name 仍为 OpenAI 工具函数名，不可随意改）
ALTER TABLE skills ADD COLUMN display_name TEXT NOT NULL DEFAULT '';

UPDATE skills SET display_name = '事务委派' WHERE id = 'skill-builtin-delegate';
UPDATE skills SET display_name = '诚实声明' WHERE id = 'skill-builtin-honesty';
UPDATE skills SET display_name = '天气查询' WHERE id = 'skill-builtin-weather';

UPDATE skills SET display_name = name WHERE trim(display_name) = '';
