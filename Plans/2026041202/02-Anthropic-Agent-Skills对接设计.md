# Anthropic Agent Skills 对接设计

> **执行状态**：设计草案（未落地 `Apps/`）  
> **批次**：`2026041202`  
> **关联**：[01-Agent-Skills架构设计.md](01-Agent-Skills架构设计.md) 描述**本仓库内**目录/绑定/运行时；本文描述与 **Anthropic 官方 Agent Skills** 的对接，二者互补，不互相替代。

---

## 1. 用户问题

- 希望将当前基于 **OpenAI 兼容 `tools` + 本地 `dispatch_tool`** 的能力体系，演进为使用 **Anthropic 官方定义的 Agent Skills**（`SKILL.md`、Skills API、代码执行容器、`skill_id` 等）。
- **该怎么做**（在不大改产品前提下的可执行设计结论）。

---

## 2. 问题解析

### 2.0 范式与厂商实现

**Anthropic Agent Skills** 在公开文档里体现的，首先是一种**可迁移的工程范式**（设计思路），而不是「只有 Claude 才能用的商标功能」。任何 Agent 产品都可以**参照同一范式**做自家实现，例如：

- **渐进披露**：先轻量元数据（发现与路由），再按需加载说明正文与附属资源，控制上下文与成本。
- **能力包**：把领域流程、约束与可选脚本打成**可版本、可绑定到 Agent** 的单元（官方用目录 + `SKILL.md`；其它产品可用数据库行、插件包、wasm 等）。
- **声明与执行分离**：对模型/用户暴露的「能做什么」与运行时「如何执行」分层，便于审计与替换后端。

**厂商实现层**才是与具体云绑定的部分：Anthropic 的 Messages API、Skills API、代码执行容器、`skill_id`、beta header 等。若产品**采纳范式但不使用 Claude**，应实现「符合范式的 Skill 模型与加载策略」，而不是逐字段模拟官方 API。

本文 **§3** 在写「对接」时，同时区分：**（A）在自有架构中贯彻范式**（与 [01-Agent-Skills架构设计.md](01-Agent-Skills架构设计.md) 一致；细化见 **[03-Agent-Skills范式-能力系统再设计.md](03-Agent-Skills范式-能力系统再设计.md)**）与 **（B）可选地接入 Anthropic 云端实现**。

### 2.1 术语与事实

- **Anthropic Agent Skills** 的规范以官方文档为准：[Agent Skills 概览](https://docs.anthropic.com/en/docs/agents-and-tools/agent-skills/overview)、[与 Claude API 一起使用 Skills](https://docs.anthropic.com/docs/en/build-with-claude/skills-guide)。
- **不是** OpenAI Chat Completions 里 `tools[]` 的等价物：Skills 依赖 **Messages API**、**Skills API（上传/管理 Skill 包）**、**代码执行**与 **beta 能力**（header、版本以官方当前文档为准）。
- **当前 `Apps/agent-hub` 实现**（`chat.rs`）：`async-openai` + DeepSeek 兼容端点、`load_tools` 生成 `ChatCompletionTool`、`dispatch_tool` 在 Rust 内执行。与 Anthropic Skills **无 API 级兼容层**。

### 2.2 约束与风险


| 约束        | 说明                                                                  |
| --------- | ------------------------------------------------------------------- |
| **模型**    | 使用完整 Skills 能力需 **Claude API**；DeepSeek 路径无法「原样挂载」Anthropic Skills。 |
| **执行位置**  | 官方模型是 **Anthropic 侧容器**内 bash/脚本；本地 Tauri 逻辑（委派、本地 DB）与容器默认隔离。      |
| **成本与合规** | 双密钥、计费、数据驻留（含官方文档对 ZDR 等说明）需产品确认。                                   |
| **工程复杂度** | 新增一整条 **Messages API** 编排，与现有 `run_chat_rounds` 并行或替换，均属大改。         |


### 2.3 与 `01` 文档的关系

- `01` 中的 **Skill 目录 / `agent_skills` / Registry** 仍是**本仓库**的长期工程模型。
- 本文解决：**若产品选择 Anthropic Skills**，如何与 `01` 并存（例如 `kind = anthropic_skill` + 存 `anthropic_skill_id`），而不是把 `01` 推翻。

---

## 3. 解答 / 实现方案

### 3.1 总体策略（推荐：**双轨**，分期）

1. **轨 A（保留）**：现有 **DeepSeek + `tools` + `dispatch_tool`**，满足无 Claude 密钥或需保留当前行为的用户。
2. **轨 B（新增）**：**Claude Messages API + Agent Skills**（预置 `skill_id` 与/或上传的自定义 Skill），仅在用户为某会话/助手选择 **Claude preset** 时启用。

**原则**：不在单一路径上假装「Skills 已等于 tools」；UI 与配置层明确 **模型与能力体系** 的对应关系。

### 3.2 产品面决议（待你确认，设计先列选项）


| 决议点       | 选项 A                                             | 选项 B                      |
| --------- | ------------------------------------------------ | ------------------------- |
| 预设模型      | 仅新增「Claude」一类 preset，与 DeepSeek 并列               | 默认仍 DeepSeek，高级入口开 Claude |
| 能力选择 UI   | 选 Claude 时展示 **Anthropic skill 选择**（预置 + 已上传自定义） | 与现有穿梭 UI 分屏或分步，避免混列两种语义   |
| 自定义 Skill | 用户上传 zip / 目录，经 Skills API 注册后存本地 `skill_id`     | 仅使用官方预置 Skill，自定义延后       |


### 3.3 工程分期（建议）


| 阶段     | 目标               | 主要内容（设计级）                                                                                                   |
| ------ | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **P0** | 可行性              | 独立 PoC：硬编码密钥，调通 Messages API + **一个预置 Skill** + code execution，验证 header 与计费。                               |
| **P1** | 管线并联             | `hub` 内抽象 `ChatBackend`：`DeepSeekOpenAi` / `ClaudeMessages`；会话或 `llm_preset_id` 路由；**不改**原 DeepSeek 默认路径行为。 |
| **P2** | Skill 资产         | Skills API 上传/列举；本地表存储 `anthropic_skill_id`、版本、与 Agent 绑定；可选从 zip 落盘到 `app_data`。                           |
| **P3** | 与现有 `skills` 表关系 | 定义 `skill_kind`：`openai_tool` | `anthropic_packaged_skill`；仅后者参与 Claude 请求；迁移脚本与 UI 分流。                     |
| **P4** | 本地能力             | 委派、仅本地可做的逻辑：**不**强行搬进容器；通过 **自定义 Skill 文案** + **Tauri 命令桥** 或 **MCP/本地 HTTP** 单独设计（另开子方案）。                  |


### 3.4 数据与配置（概念模型）

- `**agents` / `conversations`**：已有 `llm_preset_id` 可扩展为含 `claude_*`，用于路由轨 B。
- **新表（建议名，实现时可调）**：`anthropic_skills` 或扩展 `skills`  
  - 字段示例：`id`（本地 UUID）、`anthropic_skill_id`（API 返回）、`display_name`、`source`（prebuilt | uploaded）、`created_at`。
- `**agent_skills`**：若保留单表，需能区分「绑定的是 DB 工具行」还是「Anthropic skill 行」；或拆为 `agent_anthropic_skills(agent_id, local_skill_ref)`，避免一行两义。

### 3.5 运行时差异（设计摘要）

- **轨 A**：`load_tools` → `tools` → `tool_calls` → `dispatch_tool`（现状）。
- **轨 B**：不按 OpenAI `tools` 列表挂载 Anthropic Skills；按官方文档组 **Messages** 请求，在 **container / skill 引用** 中传入 `skill_id`；**工具结果**形态与 `tool` 消息不同，需单独解析 **code execution / assistant 块**。

### 3.6 风险与缓解

- **双栈维护成本**：抽象后端接口、集成测试分轨；文档写明「何种 preset 支持何种能力」。
- **容器内无法访问本地委派**：产品声明「Claude 会话下委派能力降级/不可用」或单独做桥接里程碑。
- **文档漂移**：Anthropic beta header 与字段名变更 — 封装一层配置，版本号集中管理。

---

## 4. 待决项（需产品拍板）

1. 是否 **必须** 保留 DeepSeek 为主路径（影响双轨是否长期存在）。
2. 自定义 Skill 是否在 **MVP** 范围内，或仅预置 Skill。
3. 委派（`request_agent_help`）在 Claude 轨的 **可用性定义**（禁用 / 桥接 / 延后）。
4. `01` 中的 **SkillRegistry** 与 Claude 轨的 **Skills API** 是否共用「能力」一词在 UI 上展示 — 若共用，需文案区分「本地工具」与「Anthropic Skill 包」。

---

## 5. 修订记录


| 日期         | 说明                                                |
| ---------- | ------------------------------------------------- |
| 2026-04-12 | 初稿：按 `plans-apps-workflow` 交付设计；双轨策略、分期、数据概念与待决项。 |
| 2026-04-12 | 补充 §2.0：范式 vs 厂商实现；任何 Agent 产品可按范式自建，云端 API 为可选层。 |
| 2026-04-12 | §2.0 增加指向 `03`（范式下能力系统再设计）的链接。 |


