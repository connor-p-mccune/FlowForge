CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  graph_json   TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS executions (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  triggered_by TEXT REFERENCES users(id),
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS execution_steps (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  node_type    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  input_json   TEXT,
  output_json  TEXT,
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS webhooks (
  id                TEXT PRIMARY KEY,
  workflow_id       TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  webhook_key       TEXT UNIQUE NOT NULL,
  name              TEXT,
  created_by        TEXT REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_triggered_at TEXT
);

-- Phase 8 (analytics): the summary/timeline/workflows queries scan executions by
-- workflow + time range. (The execution_steps(execution_id, node_type) index is
-- created in config/database.js, after the node_type column migration runs.)
CREATE INDEX IF NOT EXISTS idx_executions_workflow_started
  ON executions (workflow_id, started_at);
