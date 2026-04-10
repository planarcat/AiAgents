-- 批次 2026040402：skills / agent_skills / app_meta / 委派字段 / 会话与消息
CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY NOT NULL,
    builtin_code TEXT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    parameters_json TEXT NOT NULL,
    handler TEXT NOT NULL DEFAULT 'builtin'
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    PRIMARY KEY (agent_id, skill_id),
    FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE,
    FOREIGN KEY (skill_id) REFERENCES skills (id) ON DELETE CASCADE
);

-- 必要 Skills 种子（稳定 id，与 Plans/2026040402/01 §3 对齐）
INSERT OR IGNORE INTO skills (id, builtin_code, name, description, parameters_json, handler) VALUES
(
    'skill-builtin-delegate',
    'delegate_to_agent',
    'request_agent_help',
    '当需要另一位助手协助完成事务时，向指定助手发起委派。若当前设置不允许委派、或目标不接受入站、或无可用目标，将收到明确错误说明。',
    '{"type":"object","properties":{"to_agent_id":{"type":"string","description":"目标助手 ID"},"intent":{"type":"string","description":"希望对方完成的任务意图"},"payload":{"type":"object","description":"可选结构化上下文"}},"required":["to_agent_id","intent"]}',
    'builtin'
),
(
    'skill-builtin-honesty',
    'honesty_acknowledge',
    'honesty_acknowledge',
    '当你无法可靠完成用户请求、或缺少必要条件时调用，简要说明限制；勿编造事实。',
    '{"type":"object","properties":{"reason":{"type":"string","description":"无法完成或需声明的限制（简要）"}},"required":["reason"]}',
    'builtin'
);

-- 已存在的 agents 行补齐必要 Skills（升级库时首装可能早于 agent_skills）
INSERT OR IGNORE INTO agent_skills (agent_id, skill_id)
SELECT id, 'skill-builtin-delegate' FROM agents;
INSERT OR IGNORE INTO agent_skills (agent_id, skill_id)
SELECT id, 'skill-builtin-honesty' FROM agents;

ALTER TABLE agents ADD COLUMN allows_outgoing_delegation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN accepts_incoming_delegation INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    llm_preset_id TEXT NOT NULL DEFAULT 'deepseek_default',
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    UNIQUE (agent_id),
    FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime ('now')),
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);
