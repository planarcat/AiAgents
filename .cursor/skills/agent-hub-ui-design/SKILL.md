---
name: agent-hub-ui-design
description: >-
  agent-hub 客户端的 UI/样式与交互规范：改界面或新增组件前先读此 Skill，再按项目
  index.css 设计令牌与 shadcn 组件实现；含滚动分区、按钮图标优先、长耗时反馈与按模型密钥等约定。
---

# agent-hub UI / 样式设计规范

适用仓库路径：`Apps/agent-hub/`（Tauri 2 + React + Tailwind + Radix / shadcn 风格组件）。

## 1. 改样式前的顺序

1. 阅读 `src/index.css` 中的 CSS 变量（背景、主色、圆角、暗色等），**优先用令牌**（`bg-background`、`text-foreground`、`border-border`、`primary` 等），避免硬编码色值。
2. 组件样式与 `tailwind.config.cjs` 中的 `theme.extend` 对齐；复用 `src/components/ui/*`，不重复造基础控件。
3. 大改视觉时同步检查 **浅色 / 深色**（`.dark` 变量）下对比度与边框可见性。

## 2. 滚动与布局

- **主窗口壳层不滚动**：`html, body, #root` 保持 `overflow: hidden` + 有限高度；根布局使用 `h-[100dvh]`、`max-h-[100dvh]`、`overflow-hidden`。
- **仅内容区内部**（如对话消息列表）使用 `ScrollArea` 或带 `min-h-0 flex-1 overflow-auto` 的区域出现滚动条；侧栏若列表过长，仅在**侧栏内部**滚动，不让整页滚动。

## 2.1 动效与过渡

- 主内容区切换、消息块、弹层等使用 **tailwindcss-animate**（`animate-in`、`fade-in`、`slide-in`、`zoom-in` 等），时长约 **200–300ms**，`ease-out`。
- 须尊重 **`prefers-reduced-motion`**：对进入动画加 `motion-reduce:animate-none`，避免强制动效；可复用 `index.css` 中 `.animate-enter` / `.animate-enter-subtle`。

## 3. 按钮与文案

- **默认以图标为主**：`size="icon"`，并用 **`title` + `aria-label`** 说明功能（无障碍与悬停提示）。
- **仅当动作复杂、仅凭图标易误解时** 再并列显示简短中文（例如多步表单项旁的说明标签，而非每个操作键都堆字）。
- 破坏性操作（删除等）仍可用图标按钮，但必须 **`aria-label` / `title` 写清后果**。

## 4. 长耗时与对话反馈

- 对 **发送消息等阻塞调用**：应 **乐观展示用户消息**（不必等后端返回再出现）；助手侧在等待期间展示 **阶段提示**（思考 / 分析 / 工具 / 生成等），可与后端 `chat_reply_phase` 事件对齐。
- 避免「长时间无反馈后一次性吐出」的交互；结束或出错后用服务端列表 **校准** 消息状态。

## 5. 密钥与安全

- **API 密钥按大模型（会话 `llm_preset_id`）分区存储**，不得假设「一把密钥适用所有模型」；前端校验、密钥弹窗与后端 `settings_*_llm_key` / `hub_load_api_key_for_preset` 保持一致。
- 新增模型预设时：**同时**扩展后端 `assert_known_preset`、密钥 keyring 命名、前端提供商列表与文案。

## 6. 产品文案

- 省略面向开发者的架构说明（例如「首期仅某模型」「侧栏仅用于…」等）在 **用户界面** 上的展示；用户可见文案保持短、可操作。

## 7. 与本 Skill 的关系

后续任何 **样式 / UI / 交互** 相关修改，应先核对本节规则再动手；若规则与实现冲突，**先更新本 Skill** 再改代码，避免规范漂移。
