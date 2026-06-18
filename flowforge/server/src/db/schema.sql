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
  status       TEXT NOT NULL DEFAULT 'draft',
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

-- Version history: each "deploy" snapshots the workflow's current graph here with
-- a per-workflow incrementing version number, so a workflow can be rolled back to
-- any prior deploy. Restoring snapshots the live state first (see routes/
-- workflows.js), which makes a rollback itself reversible. graph_json mirrors the
-- column on workflows; created_by is the deploying user (LEFT JOINed for display,
-- so a deleted user doesn't drop the version from history).
CREATE TABLE IF NOT EXISTS workflow_versions (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  graph_json  TEXT NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
  ON workflow_versions (workflow_id, version);

-- Built-in workflow templates for the gallery. Global (not workspace-scoped):
-- read by the public GET /api/templates and cloned into a workspace's workflows.
-- graph_data holds the same {"nodes":[...],"edges":[...]} shape as workflows.graph_json.
-- Populated by db/templates.js (auto-seeded on startup when the table is empty).
CREATE TABLE IF NOT EXISTS templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  graph_data  TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Phase 8 (analytics): the summary/timeline/workflows queries scan executions by
-- workflow + time range. (The execution_steps(execution_id, node_type) index is
-- created in config/database.js, after the node_type column migration runs.)
CREATE INDEX IF NOT EXISTS idx_executions_workflow_started
  ON executions (workflow_id, started_at);

-- In-app notifications (bell menu). Written by services/notificationService.js
-- (e.g. a failed run, a workspace invite) and read by GET /api/notifications.
-- Delivered live over Socket.io to the recipient's personal room (user:<id>);
-- this row is the source of truth, so a missed live emit self-heals on next fetch.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id),
  type       TEXT,
  title      TEXT,
  message    TEXT,
  link       TEXT,
  is_read    INTEGER DEFAULT 0,
  created_at TEXT
);

-- The bell lists a user's newest notifications and counts unread ones.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at);
