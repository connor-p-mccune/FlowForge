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

// Webhook gate expressions: an optional FXL predicate evaluated against each
// delivery's JSON body. A non-matching delivery is acknowledged (202,
// accepted: false) without starting a run — "only fire on event == 'push'"
// happens at the door instead of as a condition node every graph repeats.
// NULL = every delivery fires (unchanged behavior).
ensureColumn('webhooks', 'filter_expression', 'TEXT')

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

// Public status pages (services/statusPage.js): an opt-in per-workspace token
// that makes GET /api/status/:token return a read-only health rollup of the
// workspace's deployed workflows (and /status/:token render it in the app).
// NULL = no status page. The token is the whole credential — rotating it
// severs every previously shared link.
ensureColumn('workspaces', 'status_page_token', 'TEXT')

// Run priority lanes (services/runPriority.js): default_priority is the lane
// this workflow's runs take unless a trigger overrides it per run
// ('high' | 'normal' | 'low'); executions.priority records the lane each run
// actually took, so history can show it. Added here (idempotent ALTER) so
// existing databases pick up the columns without a wipe.
ensureColumn('workflows', 'default_priority', "TEXT NOT NULL DEFAULT 'normal'")
ensureColumn('executions', 'priority', 'TEXT')

// Heartbeat monitoring (services/heartbeatMonitor.js) — a dead-man's switch
// per workflow: heartbeat_interval_minutes declares "a real run of this
// workflow should complete successfully at least this often"; NULL = no
// expectation. heartbeat_alerted_at is the edge-trigger state: set when the
// monitor raises the missed-heartbeat alert, cleared when a fresh success
// lands (which also emits a recovered event) — so a long silence alerts
// once, not once per sweep.
ensureColumn('workflows', 'heartbeat_interval_minutes', 'INTEGER')
ensureColumn('workflows', 'heartbeat_alerted_at', 'TEXT')

// Per-workflow rate limiting (services/concurrencyGate.js): cap how many runs
// a workflow may *start* within a rolling time window, independent of how many
// run at once (that's max_concurrent_runs). rate_limit_max is the ceiling and
// rate_limit_window_seconds is the window; both NULL = no limit (they're set
// and cleared together). A submission over the limit is refused with a 409 at
// every entry point — the same admission gate the concurrency cap uses — so a
// runaway schedule or webhook sender can't hammer a downstream API. Dry runs
// are exempt, like everywhere else.
ensureColumn('workflows', 'rate_limit_max', 'INTEGER')
ensureColumn('workflows', 'rate_limit_window_seconds', 'INTEGER')

// The rate-limit gate counts a workflow's recent runs by created_at; index it
// so the count stays cheap on a busy instance. (Distinct from
// idx_executions_workflow_started, which is keyed on started_at for analytics.)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_executions_workflow_created
    ON executions (workflow_id, created_at);
`)

// Workflow pause (services/workflowPause.js): paused_at is the operational
// kill switch — while set, no new real run starts anywhere (manual, public
// API, webhook, schedule, error-handler escalation); in-flight runs settle
// normally and dry runs stay allowed. paused_by keeps who pulled the switch
// for the audit trail. NULL = active.
ensureColumn('workflows', 'paused_at', 'TEXT')
ensureColumn('workflows', 'paused_by', 'TEXT REFERENCES users(id)')
// Why the workflow is paused: 'manual' (a person pulled the switch) or
// 'maintenance' (a scheduled window auto-paused it). The distinction lets the
// maintenance sweep auto-resume only the pauses it caused, never a manual one.
ensureColumn('workflows', 'paused_reason', 'TEXT')

// Scheduled maintenance windows (services/maintenanceWindow.js): a recurring
// window during which the workflow is automatically paused, then resumed when
// it ends. maintenance_cron is the window's *start* (a cron expression, UTC,
// same engine as schedule triggers) and maintenance_duration_minutes is how
// long it stays open. Both NULL = no window (set/cleared together). Reuses the
// pause kill switch: inside a window the workflow admits no new runs, exactly
// as if a person had paused it.
ensureColumn('workflows', 'maintenance_cron', 'TEXT')
ensureColumn('workflows', 'maintenance_duration_minutes', 'INTEGER')
// The IANA zone the window's cron is interpreted in (services/timezone.js).
// NULL = UTC, which is what every window created before this column existed
// meant — so the default preserves their behaviour exactly. A named zone makes
// "pause every night at 01:00" mean 01:00 where the person on call lives, and
// keeps meaning that across a DST change instead of drifting by an hour.
ensureColumn('workflows', 'maintenance_timezone', 'TEXT')

// Run cost accounting (services/costModel.js). cost_micro_usd is integer
// micro-USD (1e-6 USD) rather than a float: dollars accumulate rounding error
// across thousands of steps and then disagree with themselves when the same
// rows are summed two different ways. usage_json records what produced the
// figure (token counts and model, or a call count), including whether it could
// be priced at all — an unpriced step must be visible as a gap, not silently
// folded into a total as zero.
ensureColumn('execution_steps', 'cost_micro_usd', 'INTEGER')
ensureColumn('execution_steps', 'usage_json', 'TEXT')
// Denormalised sum of the run's steps, so "what did this run cost?" and the
// workspace's monthly spend don't have to join through every step row.
ensureColumn('executions', 'cost_micro_usd', 'INTEGER')

// Per-workspace monthly spend cap (services/budget.js). budget_micro_usd is
// the ceiling (NULL = no budget); budget_alert_pct is the fraction of it that
// raises a warning before runs are blocked (default 0.8). budget_alerted_month
// is the edge-trigger state — the 'YYYY-MM' the warning last fired for — so a
// month of overspend alerts once, the same shape the heartbeat monitor uses.
ensureColumn('workspaces', 'budget_micro_usd', 'INTEGER')
ensureColumn('workspaces', 'budget_alert_pct', 'REAL')
ensureColumn('workspaces', 'budget_alerted_month', 'TEXT')

// SLO error budgets (services/sloBudget.js). slo_target is the *success*
// fraction the workflow promises (0.99 = "99% of runs succeed") over
// slo_window_days (default 28). Distinct from sla_min_success_rate, which is a
// floor that alerts the moment it is crossed: an objective explicitly *budgets*
// for failure, so the question becomes how fast the allowance is being spent
// rather than whether anything failed at all. NULL = no objective declared.
ensureColumn('workflows', 'slo_target', 'REAL')
ensureColumn('workflows', 'slo_window_days', 'INTEGER')

// Distributed tracing (services/tracing.js). trace_id is the W3C trace this
// run belongs to — adopted from an inbound `traceparent` when a caller supplied
// one, minted otherwise — and root_span_id is the run's own span. parent_span_id
// is the caller's span, set only when the trace was adopted; NULL means this run
// is a trace root, which is different from "parented to nothing" and is why the
// export omits the field rather than writing zeros.
ensureColumn('executions', 'trace_id', 'TEXT')
ensureColumn('executions', 'root_span_id', 'TEXT')
ensureColumn('executions', 'parent_span_id', 'TEXT')
// Each step's span. An HTTP node injects this id into the request it makes, so
// whatever the far side records hangs off the exact step that called it.
ensureColumn('execution_steps', 'span_id', 'TEXT')

// Correlating a run from a trace id seen in another system ("this Jaeger trace
// touched FlowForge — which run was it?") is the whole point of storing it.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_executions_trace ON executions (trace_id);
`)

// Schedule backfill (services/backfill.js): re-running a scheduled workflow
// over a historical window. logical_date is the scheduled instant a run
// *represents*, which is not the instant it executes — a backfill of last
// Tuesday runs today but is "about" last Tuesday, and the graph reads that
// through its trigger payload to fetch the right slice of data. backfill_id
// groups the runs one submission created, so progress can be reported and the
// whole batch cancelled together. Both NULL for every ordinary run.
ensureColumn('executions', 'logical_date', 'TEXT')
ensureColumn('executions', 'backfill_id', 'TEXT')

// Backfills ask two questions repeatedly: "does this workflow already have a
// run for this logical date?" (the skip-existing check, once per occurrence)
// and "how is batch X progressing?".
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_executions_logical_date
    ON executions (workflow_id, logical_date);
  CREATE INDEX IF NOT EXISTS idx_executions_backfill
    ON executions (backfill_id);
`)

// Progressive delivery (services/canary.js). While a canary runs, a slice of a
// workflow's traffic executes the **live canvas** (the edits under test) and the
// rest executes a pinned **version snapshot** (the last known-good deploy) —
// which is what makes a rollback instant and non-destructive: stable was already
// on the baseline, so rolling back is setting the percentage to zero.
//
// canary_baseline_version_id is that snapshot; canary_percent is the share of
// runs the canary receives; canary_state is 'running' or 'rolled_back' (kept
// rather than cleared, so the reason stays on screen); canary_min_runs is how
// many canary runs must accumulate before a verdict; canary_auto opts into
// automatic promote/rollback rather than reporting only. All NULL = no canary.
ensureColumn('workflows', 'canary_baseline_version_id', 'TEXT REFERENCES workflow_versions(id) ON DELETE SET NULL')
ensureColumn('workflows', 'canary_percent', 'INTEGER')
ensureColumn('workflows', 'canary_state', 'TEXT')
ensureColumn('workflows', 'canary_started_at', 'TEXT')
ensureColumn('workflows', 'canary_min_runs', 'INTEGER')
ensureColumn('workflows', 'canary_auto', 'INTEGER')

// Which arm of the experiment a run belonged to ('canary' | 'stable'), and the
// version it executed. graph_version_id NULL means the run used the live graph,
// which is both what a canary run does and what every run of a workflow without
// a canary does — so the column names a snapshot only when one was pinned.
// release_channel NULL means the run was outside the experiment entirely (a dry
// run, or any run before a canary existed), which is why the analysis can
// select on it without restating the rules that produced it.
ensureColumn('executions', 'release_channel', 'TEXT')
ensureColumn('executions', 'graph_version_id', 'TEXT')

// The canary analysis counts a workflow's settled runs per channel since the
// experiment started — one indexed scan rather than a table walk per sweep.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_executions_release
    ON executions (workflow_id, release_channel, created_at);
`)

// Chaos profile (services/faultInjection.js): deliberate faults injected into a
// workflow's steps so the failure machinery — retries, on-error branches,
// error-handler workflows, SLA budgets — can be exercised on purpose instead of
// waiting for a real dependency to break. JSON: { enabled, scope, expiresAt,
// rules[] }. NULL = no profile.
//
// Stored as one column rather than a table because it is per-workflow config
// with no independent lifetime and no query of its own — and because every
// profile carries a mandatory `expiresAt`, so the rows would be transient
// anyway. Chaos is an experiment, not a setting.
ensureColumn('workflows', 'chaos_config', 'TEXT')

// Compensating transactions (services/compensation.js). rollback_policy decides
// what a run ending badly does about the side effects it already caused:
// 'failure' (default) unwinds a failed run by running each succeeded node's
// compensation in reverse completion order, 'failure-or-cancel' also unwinds a
// cancelled one, and 'off' is the operator kill switch for when the compensating
// endpoint is itself the thing that is broken. Stored as a policy rather than a
// boolean because the cancel question has a genuine answer per workflow —
// abandoning a half-done deploy is not the same as abandoning a half-done report.
ensureColumn('workflows', 'rollback_policy', "TEXT NOT NULL DEFAULT 'failure'")

// The position of a step in the run's real completion sequence — 0 for the
// first node whose runner returned, 1 for the next, and so on. The DAG says
// what *may* run in parallel; it does not record what actually finished first,
// and with EXEC_MAX_PARALLEL > 1 two independent branches genuinely interleave.
// Rollback unwinds in the order things happened, so the order has to be stored
// rather than re-derived from a topological sort that never knew it.
//
// NULL carries a second meaning the compensation rule depends on: the column is
// set exactly when this run *performed the node's work*, so a skipped, cached or
// reused step is NULL and is therefore never compensated — undoing an effect
// that an earlier run caused, and still owns, would be a data-loss bug wearing
// a safety feature's clothes.
ensureColumn('execution_steps', 'completed_seq', 'INTEGER')

// The verdict of a run's rollback: NULL (never unwound — the overwhelming
// majority of runs), 'completed' (every compensation succeeded), or 'partial'
// (at least one failed after its retries, so the remaining inconsistency is
// known and enumerated in execution_compensations rather than merely suspected).
ensureColumn('executions', 'rollback_status', 'TEXT')

// Breakpoints (services/debugger.js). debug_json declares the breakpoints a run
// was *started* with — `{ breakpoints: [nodeId], stepFromStart }` — and NULL on
// every ordinary run. On the execution rather than the workflow, deliberately:
// a breakpoint that lived on the workflow could be hit by a schedule tick or a
// webhook delivery, so the unsafe state is made unrepresentable instead of
// forbidden by a rule somebody has to remember.
ensureColumn('executions', 'debug_json', 'TEXT')

// One row per pause. The engine inserts it and polls until somebody resumes —
// the same cooperative pattern approvals use, which is what makes a paused run
// survive whatever the process does in between and lets the resume be a plain
// HTTP request from anywhere. input_json/config_json are the *resolved* values
// the node was about to run with, stored through the run's redactor like every
// other persisted artefact; override_json is the patch a person applied before
// letting it continue.
db.exec(`
  CREATE TABLE IF NOT EXISTS execution_breaks (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    node_label TEXT,
    status TEXT NOT NULL DEFAULT 'paused',
    action TEXT,
    input_json TEXT,
    config_json TEXT,
    override_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_execution_breaks_execution
    ON execution_breaks (execution_id, created_at);
`)

// Workflow guarantees (services/guarantees.js): path invariants the author
// declares about their own graph — "this charge never runs unless that approval
// ran first" — verified over every execution the graph admits rather than over
// the one that happened to run. JSON array of { kind, node, other, note? };
// NULL/absent = none declared, which is every workflow until somebody pins one.
//
// One column rather than a table for the same reason the chaos profile is one:
// this is per-workflow config with no independent lifetime, no query of its
// own, and it travels with the graph it describes — an exported workflow that
// arrived without its invariants would be the interesting half missing.
ensureColumn('workflows', 'guarantees_json', 'TEXT')

// The workspace trust store (services/trustStore.js): the Ed25519 public keys
// this workspace will accept a workflow definition from.
//
// The workflows-as-code loop runs export → git → review → CI → import, and
// between the approval and the import the document passes through a repository,
// a CI runner, an artifact store and an HTTP call. Nothing in that chain proved
// the graph that arrived was the graph that was reviewed; a signature and a list
// of keys is what does.
//
// A revoked key keeps its row with `revoked_at` set, exactly as api_tokens do,
// because the question an incident review asks is *what did this key sign while
// it was trusted* — and a deleted row answers that with silence. UNIQUE on
// (workspace_id, fingerprint) so one key cannot be trusted twice under two
// names, which would make revoking it a game of find-them-all.
db.exec(`
  CREATE TABLE IF NOT EXISTS workspace_signing_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    added_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE (workspace_id, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_signing_keys_workspace
    ON workspace_signing_keys (workspace_id, revoked_at);
`)

// Whether this workspace refuses an *unsigned* import. Deliberately only about
// the unsigned case: a signature that fails to verify is refused whether or not
// this is set, because a broken signature is evidence of tampering and there is
// no configuration under which shrugging at it is right. Conflating the two is
// what makes signing decorative.
ensureColumn('workspaces', 'require_signed_imports', 'INTEGER NOT NULL DEFAULT 0')

// Execution leases (services/executionLease.js): which worker believes it is
// running this execution, a fencing token proving it still is, and when that
// belief stops being credible. Everything else in the reliability story assumes
// the process survives the run; these three columns are what makes "the worker
// died" a state the system can observe instead of a row stuck on 'running'
// forever.
//
// lease_token is regenerated on every acquisition and compared on every write
// that decides the run's outcome, so a worker that stalled long enough to lose
// its lease — and then came back holding all of its in-memory state — cannot
// finalise a run another worker has already adopted. lease_attempts counts
// pickups, which is what bounds a run that reliably kills its worker.
ensureColumn('executions', 'lease_owner', 'TEXT')
ensureColumn('executions', 'lease_token', 'TEXT')
ensureColumn('executions', 'lease_expires_at', 'TEXT')
ensureColumn('executions', 'lease_attempts', 'INTEGER')

// Why this run was declared lost, and how many recoveries deep it is
// (services/crashRecovery.js). NULL on the overwhelming majority of runs.
// recovery_depth rides forward onto the run a recovery creates, so a workflow
// that reliably kills its worker stops after a bounded number of attempts
// rather than looping — the same shape as the error-handler loop guard.
ensureColumn('executions', 'recovery_reason', 'TEXT')
ensureColumn('executions', 'recovery_depth', 'INTEGER')

// The sweep reads exactly this predicate — running, top-level, lease past due —
// so an instance with a long execution history does not scan the table to find
// the handful of rows that are lost.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_executions_lease
    ON executions (status, lease_expires_at);
`)

// What a workflow wants done when a worker dies mid-run
// (services/crashRecovery.js): 'safe' (default — resume automatically unless a
// step whose outcome is genuinely unknown could have had a side effect),
// 'resume' (always resume; for a graph whose steps are idempotent), or
// 'manual' (never — record the loss and leave it to a person).
//
// A policy rather than a boolean for the same reason rollback_policy is one:
// the honest answer differs per workflow. Re-running a possibly-sent charge is
// unacceptable; re-running a possibly-refetched report is nothing.
ensureColumn('workflows', 'recovery_policy', "TEXT NOT NULL DEFAULT 'safe'")

// Which branch a generated test scenario was written to cover
// (services/pathConstraints.js), as `<nodeId>:<outcome>`. NULL on every
// hand-written scenario, which is the honest answer: a person's scenario
// exercises whatever it exercises, and claiming otherwise would let the
// coverage figure report branches nothing actually asserts.
//
// It does two jobs. Regenerating matches on it, so pressing the button twice
// updates the suite instead of doubling it; and the Tests panel counts distinct
// values against the branches the analysis found, which is what makes branch
// coverage of a *workflow* a number that exists.
ensureColumn('workflow_tests', 'generated_for', 'TEXT')

// Two-factor authentication (TOTP). Optional, opt-in per user. totp_enabled stays
// 0 until the user verifies a code from their authenticator, so a half-finished
// setup never locks them out of login. totp_backup_codes is a JSON array of
// { hash, used } recovery codes. Added here (idempotent ALTER) so existing
// databases pick up the columns without a wipe.
ensureColumn('users', 'totp_secret', 'TEXT')
ensureColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('users', 'totp_backup_codes', 'TEXT')

module.exports = db
