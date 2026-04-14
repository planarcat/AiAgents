# Agent Skills 架构设计

> **执行状态**：设计草案（未落地 `Apps/`）  
> **批次**：`2026041202`（新议题线：在现有 `skills` / `agent_skills` 之上明确「Agent Skills」产品与工程模型）

---

## 1. 自上一批次未执行项（承接）

按 [Plans/2026041201/未执行方案.md](../2026041201/未执行方案.md) 的累积规则，下列项**仍有效**，本设计**不替代**其独立里程碑，仅在「Agent Skills」中预留接口或叙事衔接：

- 长会话摘要、编排侧车化等 — 与本节「运行时注入」可并行演进。
- 会话侧常驻「已装载能力」摘要 — 可作为 Agent Skills 的**只读视图**，数据源即本文 §4。

---

## 2. 用户问题

- 希望做成 **Agent Skills** 架构，**怎么做**？

**解析要点**：区分三层概念，避免与现有表名混为一谈：


| 用语                 | 含义                                                                |
| ------------------ | ----------------------------------------------------------------- |
| **Skill（能力目录项）**   | 全局注册的一条「可被绑定的能力」定义（工具形态 + 元数据）。对应库表 `skills`。                     |
| **Agent Skill 绑定** | 某个 Agent **启用**哪些 Skill。对应 `agent_skills`。                        |
| **运行时 Skill 视图**   | 某轮对话中实际注入的 `tools[]` + `dispatch_tool` 可执行集合 — 由绑定 + 健康检查 + 策略决定。 |


当前实现已具备 **目录 + 绑定 + load_tools + dispatch** 的骨架；「Agent Skills 架构」是把这层**产品化、类型化、可扩展**，而不是从零新造一套平行概念。

---

## 3. 目标态（Agent Skills 是什么）

**一句话**：每个 Agent 持有一个 **Skill 集合**（有序或无序的 `skill_id` 列表）；对话时每轮根据该集合向模型声明工具，并在 tool 回调中**安全、可观测**地执行。

**与「仅 tools 表」的差异**（架构上应显式化）：

1. **声明与执行分离**：`skills` 负责 LLM 可见的 **OpenAI Function** 声明；执行走 **注册表**（见 §5），避免无限膨胀的 `match`。
2. **类型维度**：内置固定 / 内置可配置 / MCP / 未来插件 — 在 `skills` 或扩展表上增加 **kind + 配置引用**，UI 与保存路径不同。
3. **Agent 侧策略**：哪些 Skill 默认推荐、是否允许用户卸掉「安全类」内置 — 属于产品策略，**不**再用「必选」污染目录行，而用 **runtime 注入**（已有 `BUILTIN_RUNTIME_SYSTEM_SUFFIX` 模式）或单独 `agent_policy` 字段。

---

## 4. 数据层（在现有库上演进）

### 4.1 已有（保持不变语义）

- `**skills`**：全局能力目录行。关键列：`id`、`name`（工具函数名）、`description`、`parameters_json`、`display_name`、`handler` / `builtin_code`（元数据）。
- `**agent_skills**`：`(agent_id, skill_id)`，表示绑定。

### 4.2 建议增量（按里程碑分期）


| 阶段     | 内容                                                                                                            | 目的                       |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **M1** | 不改表，仅规范命名与代码分层：`SkillRegistry` 抽象 `dispatch`                                                                  | 降低 `chat.rs` 中巨型 `match` |
| **M2** | `skills` 增加 `kind`（enum：builtin_static / builtin_config / mcp / …）                                            | UI 分流、保存校验               |
| **M3** | **能力实例**表：`skill_instances`（`id`, `template_skill_id`, `config_json`, …），`agent_skills` 改为可挂 **实例 id** 或增加关联表 | T2「创建天气能力」等多实例           |
| **M4** | MCP：`mcp_connections` + 与 `skills` 或实例的映射                                                                     | 与 `rmcp` 衔接              |


**原则**：**Agent 保存的仍是「选了哪些 Skill（或实例）」**；全局目录的增删改与助手指令分权（管理员式「能力库」vs 助手表单）。

---

## 5. 运行时层（核心契约）

1. **加载**：`load_tools(agent_id)` → 仅包含**已绑定且当前可用**的 Skill 对应的 `ChatCompletionTool`。
2. **权限**：`agent_allows_tool_by_name`（已有）— 防止模型 hallucinate 工具名。
3. **执行**：`dispatch_tool` → 改为 **SkillExecutor / Registry**：
  `resolve(tool_name) -> Option<impl SkillHandler>`  
   内置实现注册进表；MCP 走另一分支读连接信息。
4. **系统提示**：每轮附加 **能力清单**（已有 `build_capabilities_system_suffix`）+ **内置行为**（常量后缀）— 「不可关闭」的规则放这里，不放 `skills.is_required`。

---

## 6. 前端 / 产品（Agent 配置）

- **Agent 编辑页**：展示 **Agent Skills** = 当前 `agent_skills` 的列表（图标 + 名称 + 说明 + 穿梭）。
- **能力库**（远期）：管理全局 `skills`（及实例），与 [Plans/2026040601/01-Agent能力与UI能力库.md](../2026040601/01-Agent能力与UI能力库.md) 中 T1/T2/T3 一致。
- **保存**：与现有一致 — `agents_update(..., skill_ids)` → 后端 `merge_and_validate_skill_ids` + `replace_agent_skills`。

---

## 7. 落地顺序建议

1. **重构不分期**：`dispatch_tool` → 注册表 + 单元测试（行为与现有一致）。
2. **表扩展**：`kind` 列 + 迁移脚本。
3. **能力库 UI**：先只读目录 + Agent 多选（已基本具备），再「创建 T2 实例」。
4. **MCP**：独立里程碑，接 `SkillRegistry` 的 MCP 后端。

---

## 8. 待决项

- `agent_skills` 是否需要 **排序** 列（影响 UI 展示顺序 vs 模型优先级 — 通常仅 UI）。  
- T2 实例的 **工具函数名** `name`：全局唯一（带实例后缀）还是共享 `name` + 实例走闭包 — 影响 LLM 侧歧义，需单独定稿。

---

## 9. 修订记录


| 日期         | 说明                                         |
| ---------- | ------------------------------------------ |
| 2026-04-12 | 初稿：Agent Skills 概念分层、数据与运行时演进、与既有 Plan 衔接。 |
| 2026-04-12 | 增加关联文档：Anthropic 官方 Skills 对接见 `02-Anthropic-Agent-Skills对接设计.md`。 |
| 2026-04-12 | 关联 `03`：按范式再设计能力系统（L1/L2/L3、system 组装）。 |
| 2026-04-12 | §10 增加 `执行方案（已执行）.md`、`未执行方案.md`。 |

---

## 10. 关联文档

- **[03-Agent-Skills范式-能力系统再设计.md](03-Agent-Skills范式-能力系统再设计.md)**：按 **Agent Skills 范式**对 `agent-hub` 能力系统的**再设计**（渐进披露三层、数据列、每轮 system 组装、Registry）；**不依赖** Claude 云端。
- **[02-Anthropic-Agent-Skills对接设计.md](02-Anthropic-Agent-Skills对接设计.md)**：与 **Anthropic 官方 Agent Skills**（Messages API、Skills API、容器）的对接策略、双轨分期与待决项；与本文「本仓库内 Agent Skills 模型」互补。
- **[执行方案（已执行）.md](执行方案（已执行）.md)**、**[未执行方案.md](未执行方案.md)**：本议题线 **2026041202** 批次结案与未结项累积。


