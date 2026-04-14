-- Agent Skills 范式：L2（instructions_md）与 kind（[Plans/2026041202/03]）
ALTER TABLE skills ADD COLUMN instructions_md TEXT NOT NULL DEFAULT '';
ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'builtin_static';

UPDATE skills SET
  kind = 'builtin_static',
  instructions_md = '## 使用本能力时的行为

1. **何时调用**：用户询问某地「现在天气」「气温」「下雨吗」等需要**近实时气象**时，应调用 `query_weather_openmeteo`，传入用户关心的地点（`location`）。
2. **参数**：尽量使用用户原话中的地名；若用户未指定地点，先简短追问再调用。
3. **回答**：以工具返回为准组织自然语言；说明数据来自 Open-Meteo 公开接口；勿捏造工具未返回的项。
4. **局限**：不提供长期预报、分钟级预警等专业气象服务；用户若需要官方预警渠道，应提示其查阅当地气象部门。'
WHERE id = 'skill-builtin-weather';
