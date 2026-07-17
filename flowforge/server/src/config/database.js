const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/flowforge.db')

const dbDir = path.dirname(DB_PATH)
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true })
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8')
db.exec(schema)

// Lightweight additive migrations. better-sqlite3 has no migration framework and
// schema.sql uses CREATE TABLE IF NOT EXISTS, so columns added after a database
// already exists are applied here: ALTER only when the column is missing, so
// existing dev/prod databases pick up new fields without a wipe.
function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

// Schedule triggers: workflows carry a deploy status ('draft' | 'deployed' |
// 'archived') so the scheduler can re-register cron jobs for deployed workflows on
// startup, and stop them on archive/delete. Added here (idempotent ALTER) so
// existing databases pick up the column without a wipe.
ensureColumn('workflows', 'status', "TEXT NOT NULL DEFAULT 'draft'")

// Phase 8 (analytics): node_type denormalises each step's node type at run time so
// per-type timing survives later edits to the workflow graph. Indexed for the
// node-usage aggregate. Created here (not in schema.sql) so the index can be built
// only after the column exists on pre-existing databases.
ensureColumn('execution_steps', 'node_type', 'TEXT')
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_execution_steps_exec_type
    ON execution_steps (execution_id, node_type);
`)

// Sub-workflow nodes: a sub-workflow runs another workflow as a step. The child
// run records which parent execution (parent_execution_id) and which parent node
// (parent_node_id) spawned it, so GET /api/executions/:id can nest the child's
// steps under the right step and reconstruct the full call tree. ON DELETE SET
// NULL so deleting a parent workflow (which cascades its executions) doesn't fail
// on a child run that still points at one — the child detaches and survives.
// Added here (idempotent ALTER) so existing databases pick up the columns.
ensureColumn('executions', 'parent_execution_id', 'TEXT REFERENCES executions(id) ON DELETE SET NULL')
ensureColumn('executions', 'parent_node_id', 'TEXT')

// Execution replay: trigger_data persists the original trigger payload (webhook
// body, manual/schedule metadata) as JSON so a past run can be re-run with the
// identical input; trigger_type records how the run was started
// ('manual' | 'webhook' | 'schedule' | 'replay'). triggered_by stays the user FK
// (who, if anyone, started it) — replays carry the user who clicked Replay, so a
// dedicated trigger_type column marks them without breaking that foreign key.
ensureColumn('executions', 'trigger_data', 'TEXT')
ensureColumn('executions', 'trigger_type', 'TEXT')

// Webhook HMAC signing (SECURITY.md T3): optional per-webhook shared secret.
// NULL = unsigned webhook (key-only auth, unchanged behavior); set = every
// delivery must carry a valid timestamped HMAC (services/webhookSignature.js).
ensureColumn('webhooks', 'signing_secret', 'TEXT')

// Run cancellation: cancel_requested is the cooperative stop flag. The cancel
// routes set it; the engine polls it between node settlements and winds the run
// down ('cancelled' status) at the next scheduling round. A run cancelled while
// still queued is finalized directly by the route, and the worker skips it.
ensureColumn('executions', 'cancel_requested', 'INTEGER NOT NULL DEFAULT 0')

// Status badges (services/statusBadge.js): an opt-in per-workflow token that
// makes GET /api/workflows/:id/badge.svg?token=… return a public SVG of the
// workflow's latest run status (like a CI badge). NULL = no badge minted;
// without a valid token the endpoint renders a neutral 'unknown' badge, so it
// never confirms a workflow's existence.
ensureColumn('workflows', 'badge_token', 'TEXT')

// Per-workflow run concurrency (services/concurrencyGate.js):
// max_concurrent_runs caps how many of a workflow's runs may be active at once
// (NULL/0 = unlimited); concurrency_policy decides what happens to a run
// submitted at the cap — 'queue' (default) parks it until a slot frees,
// 'reject' refuses the submission with a 409.
ensureColumn('workflows', 'max_concurrent_runs', 'INTEGER')
ensureColumn('workflows', 'concurrency_policy', "TEXT NOT NULL DEFAULT 'queue'")

// Resume-from-failure: a resumed run points back at the failed/cancelled run it
// continues. The engine reads the source run's succeeded steps and reuses their
// recorded outputs (step status 'reused') instead of re-executing them, so only
// the failed portion of the graph runs again. ON DELETE SET NULL — pruning the
// source run detaches the resume rather than deleting it.
ensureColumn('executions', 'resumed_from_execution_id', 'TEXT REFERENCES executions(id) ON DELETE SET NULL')

// Per-workflow SLA targets (services/slaMonitor.js). Both optional and
// independent: sla_max_duration_ms is the wall-time budget a completed run
// should stay under, and sla_min_success_rate (0..1) is the floor the rolling
// success rate over recent runs must hold. NULL on either = that objective is
// unset. When a top-level run finishes, the monitor checks the run against these
// (plus the statistical anomaly check, which needs no config) and raises a
// notification + activity event on a breach. Added here (idempotent ALTER) so
// existing databases pick up the columns without a wipe.
ensureColumn('workflows', 'sla_max_duration_ms', 'INTEGER')
ensureColumn('workflows', 'sla_min_success_rate', 'REAL')

// Error-handler workflow (services/errorHandler.js): when one of this
// workflow's real, top-level runs fails, the designated workflow is triggered
// with the failure context as its payload (trigger_type 'error-handler').
// NULL = no handler. ON DELETE SET NULL so deleting the handler workflow
// quietly clears the reference instead of blocking the delete.
ensureColumn('workflows', 'error_workflow_id', 'TEXT REFERENCES workflows(id) ON DELETE SET NULL')

// Run priority lanes (services/runPriority.js): default_priority is the lane
// this workflow's runs take unless a trigger overrides it per run
// ('high' | 'normal' | 'low'); executions.priority records the lane each run
// actually took, so history can show it. Added here (idempotent ALTER) so
// existing databases pick up the columns without a wipe.
ensureColumn('workflows', 'default_priority', "TEXT NOT NULL DEFAULT 'normal'")
ensureColumn('executions', 'priority', 'TEXT')

// Two-factor authentication (TOTP). Optional, opt-in per user. totp_enabled stays
// 0 until the user verifies a code from their authenticator, so a half-finished
// setup never locks them out of login. totp_backup_codes is a JSON array of
// { hash, used } recovery codes. Added here (idempotent ALTER) so existing
// databases pick up the columns without a wipe.
ensureColumn('users', 'totp_secret', 'TEXT')
ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'totp_backup_codes', 'TEXT')

module.exports = db
