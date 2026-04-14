# 示例 Skill：天气查询（对齐 `03` 最新方案）

> **说明**：下列 **L1/L2 拆分**与 **`instructions_md` / `kind`** 依赖迁移在 `skills` 表上**新增列**（见 [03 §4.1](03-Agent-Skills范式-能力系统再设计.md)）。在迁移落地前，仓库里现有种子仍只有 L1 等价字段；本文件表示**目标形态**的示例。

---

## 1. 逻辑分层对应

| 层级 | 本示例 |
|------|--------|
| **L1** | `id`、`display_name`、`name`（工具名）、`description`、`parameters_json` — 进入 `tools[]` 与 `skills_catalog` |
| **L2** | `instructions_md` — 仅当 Agent **已绑定**本 Skill 时，拼入**当轮 system**（不写入 `messages` 历史） |
| **执行** | `builtin_code` / Registry：`weather_openmeteo` → 现有 Open-Meteo 逻辑（与 `dispatch_tool` 对齐） |

---

## 2. SQLite 行（目标列；示意）

`skill_id`：`skill-builtin-weather`（与现有种子一致，便于升级）

| 列 | 示例值 |
|----|--------|
| `id` | `skill-builtin-weather` |
| `builtin_code` | `weather_openmeteo` |
| `name` | `query_weather_openmeteo` |
| `display_name` | `天气查询` |
| `description` | 见下文 **L1 · description**（唯一说明列，兼 UI） |
| `parameters_json` | 见下文 **L1 · parameters_json**（单行 JSON 字符串） |
| `handler` | `builtin` |
| `kind` | `builtin_static` |
| `instructions_md` | 见下文 **L2** |

---

## 3. L1 · `description`（API `tools[].function.description` + UI）

```text
查询指定地点的当前天气（Open-Meteo 公开接口，近实时）。用户说城市或地区中文名时，将地名作为参数 location 传入；勿编造未返回的数值。
```

---

## 4. L1 · `parameters_json`（API `tools[].function.parameters`）

```json
{
  "type": "object",
  "properties": {
    "location": {
      "type": "string",
      "description": "城市或地区名称，例如：北京、上海、纽约"
    }
  },
  "required": ["location"]
}
```

---

## 5. L2 · `instructions_md`（仅绑定后注入 system，可截断）

```markdown
## 使用本能力时的行为

1. **何时调用**：用户询问某地「现在天气」「气温」「下雨吗」等需要**近实时气象**时，应调用 `query_weather_openmeteo`，传入用户关心的地点（`location`）。
2. **参数**：尽量使用用户原话中的地名；若用户未指定地点，先简短追问再调用。
3. **回答**：以工具返回为准组织自然语言；说明数据来自 Open-Meteo 公开接口；勿捏造工具未返回的项。
4. **局限**：不提供长期预报、分钟级预警等专业气象服务；用户若需要官方预警渠道，应提示其查阅当地气象部门。
```

---

## 6. 迁移 SQL 示意（列存在后执行）

```sql
-- 示例：在已有 INSERT OR IGNORE 种子之后，用 UPDATE 补齐 L2 / kind（列名以实际迁移为准）
UPDATE skills SET
  kind = 'builtin_static',
  instructions_md = '## 使用本能力时的行为

1. **何时调用**：用户询问某地「现在天气」「气温」「下雨吗」等需要**近实时气象**时，应调用 `query_weather_openmeteo`，传入用户关心的地点（`location`）。
2. **参数**：尽量使用用户原话中的地名；若用户未指定地点，先简短追问再调用。
3. **回答**：以工具返回为准组织自然语言；说明数据来自 Open-Meteo 公开接口；勿捏造工具未返回的项。
4. **局限**：不提供长期预报、分钟级预警等专业气象服务；用户若需要官方预警渠道，应提示其查阅当地气象部门。'
WHERE id = 'skill-builtin-weather';
```

若种子行尚未存在，可用带新列的 `INSERT`（需与 `20260406120000_skill_weather.sql` 合并策略一致，避免重复插入）。

---

## 7. 运行时片段（概念）

- **当轮 system** 中含（顺序见 [03 §5.1](03-Agent-Skills范式-能力系统再设计.md)）：  
  `… + 【能力指导：天气查询】\n + <instructions_md 截断后> + … + 能力清单后缀`  
- **`messages` 表**：不单独存 L2 文本。

---

## 8. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-12 | 初稿：天气 Skill 的 L1/L2 示例与 UPDATE 示意。 |
