# Agent Hub

跨平台桌面端多 Agent 协作应用（Tauri 2 · React · shadcn/ui · Tailwind）。产品方案见仓库内：

`Plans/2026040401/执行方案.md`

**包管理器：pnpm**（见仓库根 `packageManager` 字段与 `pnpm-lock.yaml`）。

## 技术栈（§2.1）

- 前端：Vite、React、TypeScript、Tailwind CSS、shadcn/ui（Radix）
- 后端：Tauri 2、`hub` 模块（Rust）：`sqlx` + SQLite、`async-openai`、`reqwest`、`keyring`、**rmcp**（M3 起接 MCP）

## 开发

```bash
cd Apps/agent-hub
pnpm install
pnpm run tauri:dev
```

单独调试前端（无桌面壳）：

```bash
pnpm run dev
```

## 生产构建

```bash
pnpm run tauri:build
```

## 当前进度

- **M0**：工程脚手架、Hub 最小命令 `hub_health` / `hub_db_ping`、SQLite 首迁移 `agents` 占位表
- 后续：M2 LLM、M3 builtin + MCP、M4 委派，见执行方案里程碑表

## 应用数据目录

SQLite 文件（由 Tauri `app_data_dir` 决定）中的 `agent-hub.db`。
