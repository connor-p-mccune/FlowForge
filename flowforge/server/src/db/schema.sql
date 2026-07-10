CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  -- Optional TOTP two-factor auth. totp_secret is the base32 shared secret;
  -- totp_enabled is only set to 1 once the user verifies a code; totp_backup_codes
  -- is a JSON array of { hash, used } one-time recovery codes (bcrypt-hashed).
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  totp_backup_codes TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
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

-- Figma-style canvas comments. A comment is a discussion thread pinned to a
-- flow-coordinate (x, y) on a workflow's canvas; its messages live in
-- canvas_comment_replies (the first reply is the opening comment, written in the
-- same transaction that creates the comment). Delivered live over Socket.io to the
-- workflow room (workflow:<id>) as comment-added / comment-reply-added /
-- comment-resolved — these rows are the source of truth, so a missed live emit
-- self-heals on the next GET. Resolved threads (is_resolved = 1) are hidden from
-- the canvas. author_id is nullable + LEFT JOINed for display so deleting a user
-- doesn't drop their comments.
CREATE TABLE IF NOT EXISTS canvas_comments (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id),
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  is_resolved INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS canvas_comment_replies (
  id         TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES canvas_comments(id) ON DELETE CASCADE,
  author_id  TEXT REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- GET /comments lists a workflow's unresolved threads; replies are fetched per
-- thread in created order.
CREATE INDEX IF NOT EXISTS idx_canvas_comments_workflow
  ON canvas_comments (workflow_id, is_resolved);
CREATE INDEX IF NOT EXISTS idx_canvas_comment_replies_comment
  ON canvas_comment_replies (comment_id, created_at);

-- Personal access tokens for the public REST API (/api/v1). Only a SHA-256
-- hash of the token is stored — the full value (ffp_<40 hex>) is shown once at
-- creation and cannot be recovered. token_prefix keeps the first characters
-- for display so a user can tell tokens apart. scopes is a JSON array
-- (subset of ["trigger","read"]); revocation keeps the row (revoked_at set)
-- as an audit trail rather than deleting it.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash   TEXT UNIQUE NOT NULL,
  scopes       TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The settings page lists a user's tokens newest-first.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user_created
  ON api_tokens (user_id, created_at);

-- Workspace secrets: named credentials (API keys, tokens) referenced from node
-- configs as {{secrets.NAME}}. value_encrypted is AES-256-GCM ciphertext (see
-- services/secretVault.js) — plaintext never touches the database, and the API
-- never returns a value after it is written (list endpoints expose names +
-- metadata only). The execution engine decrypts just-in-time at run start and
-- redacts the plaintext from persisted step logs and published events. Writes
-- are workspace-owner-only; created_by is kept for the audit trail (LEFT JOINed
-- for display so a deleted user doesn't drop the row).
CREATE TABLE IF NOT EXISTS workspace_secrets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, name)
);

-- Workspace activity feed: an append-only, chronological log of significant
-- actions in a workspace (workflow created/deployed/deleted/restored, execution
-- completed/failed, member invited/removed, comment added/resolved). Written by
-- services/activityService.js, which also emits each row live over Socket.io to
-- the workspace room (workspace:<id>). entity_name is denormalised so a row still
-- reads correctly after its entity is deleted; metadata is optional JSON. actor_id
-- is nullable + ON DELETE SET NULL (system/webhook actors, or a since-deleted user)
-- and LEFT JOINed to users for the display name. created_at is an ISO-8601 string
-- so the GET ?before=<ts> keyset cursor compares lexicographically.
CREATE TABLE IF NOT EXISTS activity_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type   TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  entity_name  TEXT,
  metadata     TEXT,
  created_at   TEXT NOT NULL
);

-- The feed pages newest-first within a workspace (and filters by event_type prefix).
CREATE INDEX IF NOT EXISTS idx_activity_workspace_created
  ON activity_events (workspace_id, created_at DESC, id DESC);

-- Idempotency keys for the public trigger endpoint. A retried
-- POST /api/v1/workflows/:id/trigger carrying the same Idempotency-Key returns
-- the original run instead of starting a second one — scoped per token owner
-- and workflow so one client's keys can't collide with another's.
-- request_hash pins the key to its payload (same key + different body is a
-- 409, never a silent replay); rows expire after 24h and are pruned lazily.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id  TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, workflow_id, key)
);

-- The lazy sweep deletes by age.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
  ON idempotency_keys (created_at);

-- Outbound webhooks: a workspace can subscribe an external URL to its activity
-- events (the same event_type families the feed uses — 'execution.failed',
-- 'workflow.*', or '*'). events is a JSON array of those patterns; secret signs
-- every delivery (same timestamped HMAC scheme as inbound webhook triggers) and
-- is shown once at creation. Deliveries are queued durably in event_deliveries
-- and dispatched by services/eventDispatcher.js.
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  description  TEXT,
  events       TEXT NOT NULL,
  secret       TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_subscriptions_workspace
  ON event_subscriptions (workspace_id, created_at DESC);

-- The durable outbound delivery queue: one row per subscription per matching
-- event, attempted at-least-once with exponential backoff until it lands
-- (status 'delivered'), runs out of attempts ('failed'), or its subscription
-- disappears. The row id doubles as the consumer-visible delivery id — a
-- redelivery reuses it, so receivers can deduplicate. payload_json is the
-- activity event; the envelope (id/type/createdAt/data) is built at send time.
CREATE TABLE IF NOT EXISTS event_deliveries (
  id              TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  response_status INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  delivered_at    TEXT
);

-- The dispatcher scans for due work; the UI lists a subscription's deliveries
-- newest-first.
CREATE INDEX IF NOT EXISTS idx_event_deliveries_due
  ON event_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_subscription
  ON event_deliveries (subscription_id, created_at DESC);

-- Human-in-the-loop approvals: an approval node pauses its run until a
-- workspace member responds or the wait times out. The node runner
-- (services/nodeRunners/approval.js) inserts the row as 'pending' and polls it;
-- POST /api/approvals/:id/respond flips it to 'approved'/'rejected' with the
-- pending-only guard in the UPDATE so concurrent responders can't both win. The
-- runner itself settles 'timed-out' (past expires_at) and 'cancelled' (run was
-- cancelled mid-wait). workflow_id/workspace_id are denormalised so the inbox
-- query (GET /api/approvals) doesn't join through executions; responded_by is
-- kept for the audit trail (LEFT JOINed for display).
CREATE TABLE IF NOT EXISTS execution_approvals (
  id           TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  node_id      TEXT NOT NULL,
  workflow_id  TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  message      TEXT,
  requested_at TEXT NOT NULL,
  expires_at   TEXT,
  responded_at TEXT,
  responded_by TEXT REFERENCES users(id),
  note         TEXT
);

-- The inbox lists a workspace's approvals by status; the run detail view loads
-- them per execution.
CREATE INDEX IF NOT EXISTS idx_execution_approvals_workspace
  ON execution_approvals (workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_approvals_execution
  ON execution_approvals (execution_id);
