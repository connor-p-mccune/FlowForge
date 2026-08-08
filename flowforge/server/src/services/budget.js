// Workspace spend budgets — the enforcement half of cost accounting.
//
// The failure this exists to prevent is specific and expensive: a workflow with
// an AI node inside a for-each loop, pointed at a list that grew, running on a
// schedule nobody is watching. Every other control here bounds *load* —
// concurrency bounds simultaneity, the rate limit bounds frequency, pause stops
// everything — and none of them bound **money**. A workflow can sit far inside
// every one of those limits and still spend a fortune.
//
// The design mirrors the controls it sits beside rather than inventing a new
// shape:
//
//   - It is checked in `admitRun`, the single chokepoint every entry point
//     already calls, so covering manual runs, the public API, webhooks,
//     schedules, backfills, replays, resumes, and error-handler escalations
//     took no per-route logic.
//   - Refusal is a 409 with a message that says what happened, like the
//     concurrency and rate-limit refusals — a webhook sender reads it as
//     "back off", and a person reads it as "raise the budget".
//   - The warning is edge-triggered through a single column
//     (`budget_alerted_month`), the same trick the heartbeat monitor uses: a
//     month of overspend alerts once, not once per run, and the column *is* the
//     state, so it survives restarts with nothing to reconcile.
//
// Two boundaries are deliberate. **Dry runs are exempt**, like everywhere else:
// an interactive test must not eat the production allowance, and the person
// debugging why the budget blew is the last person who should be blocked. And
// **in-flight runs are never killed** — a budget refuses new work; tearing down
// a half-finished run to save a fraction of a cent would leave the outside
// world in an unknown state for no benefit. That is cancellation's job, and it
// stays a human decision.

const db = require('../config/database')
const activityService = require('./activityService')
const { createNotification } = require('./notificationService')
const { recordBudgetBlocked } = require('./metrics')

// Warn at this fraction of the cap unless the workspace says otherwise. 80% is
// early enough to act on and late enough not to cry wolf.
const DEFAULT_ALERT_PCT = 0.8

// The current calendar month as 'YYYY-MM', in UTC.
//
// Budgets reset monthly on a *calendar* boundary rather than a rolling 30-day
// window, because that is the boundary the invoice this mirrors uses — and a
// rolling window would make "how much have we spent this month?" unanswerable
// against a bill. UTC so the reset instant doesn't depend on where the server
// happens to run.
function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7)
}

// The workspace's budget, or null when it has none.
function budgetFor(workspace) {
  const cap = Number(workspace?.budget_micro_usd)
  if (!Number.isFinite(cap) || cap <= 0) return null
  const pctRaw = Number(workspace?.budget_alert_pct)
  const alertPct = Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw < 1 ? pctRaw : DEFAULT_ALERT_PCT
  return { capMicroUsd: Math.floor(cap), alertPct }
}

// What a workspace has spent so far this month.
//
// Counts every non-dry run *created* in the month, whatever its outcome: a run
// that failed after its AI call still spent the money, and a budget that only
// counted successes would be trivially defeated by a workflow that dies on its
// last step. Costs land on the execution row as the run settles, so an
// in-flight run contributes nothing until it finishes — the check is therefore
// slightly behind reality under heavy parallelism, which is the right way to be
// wrong: it can briefly admit a run it would later refuse, but it can never
// refuse one it should have admitted.
function spentThisMonth(workspaceId, now = new Date()) {
  const monthStart = `${currentMonth(now)}-01`
  const { total } = db
    .prepare(
      `SELECT COALESCE(SUM(e.cost_micro_usd), 0) AS total
         FROM executions e
         JOIN workflows w ON w.id = e.workflow_id
        WHERE w.workspace_id = ?
          AND e.created_at >= ?
          AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')`
    )
    .get(workspaceId, monthStart)
  return total || 0
}

// A workspace's budget status, for the settings panel and the costs endpoint.
function budgetStatus(workspaceId, now = new Date()) {
  const workspace = db
    .prepare(
      'SELECT id, budget_micro_usd, budget_alert_pct, budget_alerted_month FROM workspaces WHERE id = ?'
    )
    .get(workspaceId)
  const budget = budgetFor(workspace)
  const spentMicroUsd = spentThisMonth(workspaceId, now)
  if (!budget) {
    return { month: currentMonth(now), spentMicroUsd, capMicroUsd: null, blocked: false }
  }
  return {
    month: currentMonth(now),
    spentMicroUsd,
    capMicroUsd: budget.capMicroUsd,
    alertPct: budget.alertPct,
    usedFraction: budget.capMicroUsd > 0 ? spentMicroUsd / budget.capMicroUsd : 0,
    blocked: spentMicroUsd >= budget.capMicroUsd,
  }
}

// Raise the approaching-the-cap warning at most once per calendar month.
//
// Best-effort throughout: alerting can never be allowed to fail an admission
// decision, so a broken notification path costs the warning, not the run.
function maybeAlert(workspace, spent, budget, now) {
  try {
    const month = currentMonth(now)
    if (workspace.budget_alerted_month === month) return
    if (spent < budget.capMicroUsd * budget.alertPct) return

    db.prepare('UPDATE workspaces SET budget_alerted_month = ? WHERE id = ?')
      .run(month, workspace.id)

    const pct = Math.round((spent / budget.capMicroUsd) * 100)
    // Reuse the existing fan-out — activity feed (which outbound webhooks
    // relay) plus an owner notification — rather than inventing a third
    // alerting channel, exactly as the SLA and heartbeat monitors do.
    activityService.logEvent(workspace.id, null, 'workspace.budget_warning', {
      type: 'workspace',
      id: workspace.id,
      name: workspace.name,
      metadata: { month, spentMicroUsd: spent, capMicroUsd: budget.capMicroUsd, percent: pct },
    })
    const owner = db
      .prepare(
        "SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'owner' LIMIT 1"
      )
      .get(workspace.id)
    if (owner) {
      createNotification(owner.user_id, {
        type: 'budget-warning',
        title: 'Workspace budget warning',
        message: `"${workspace.name}" has used ${pct}% of its ${month} budget`,
        link: '/',
      })
    }
  } catch (err) {
    console.error('Budget alert failed:', err.message)
  }
}

// The admission check. Returns { ok: true } or a refusal shaped like the
// concurrency and rate-limit ones, so `admitRun` can return any of them
// unchanged and every caller keeps its single 409 path.
//
// Dry runs never reach here (the gate skips them), matching every other
// admission control: a test run neither spends the allowance nor is blocked by
// it, so the person diagnosing a budget problem can still work.
function checkBudget(workflow, now = new Date()) {
  const workspace = db
    .prepare(
      'SELECT id, name, budget_micro_usd, budget_alert_pct, budget_alerted_month FROM workspaces WHERE id = ?'
    )
    .get(workflow.workspace_id)
  const budget = budgetFor(workspace)
  if (!budget) return { ok: true }

  const spent = spentThisMonth(workspace.id, now)
  maybeAlert(workspace, spent, budget, now)

  if (spent >= budget.capMicroUsd) {
    recordBudgetBlocked()
    const { formatMicroUsd } = require('./costModel')
    return {
      ok: false,
      reason: 'budget',
      error:
        `Workspace budget reached: ${formatMicroUsd(spent)} spent of ` +
        `${formatMicroUsd(budget.capMicroUsd)} for ${currentMonth(now)} — ` +
        'raise the budget to accept new runs',
    }
  }
  return { ok: true }
}

// Spend broken down for the costs endpoint. One query per grouping rather than
// a generic pivot: three shapes is fewer than the machinery to generalise them,
// and each can be indexed on its own terms.
function costBreakdown(workspaceId, { from, to, groupBy = 'workflow' } = {}) {
  const start = from || `${currentMonth()}-01`
  const end = to || new Date().toISOString()

  if (groupBy === 'day') {
    return db
      .prepare(
        `SELECT substr(e.created_at, 1, 10) AS key,
                COALESCE(SUM(e.cost_micro_usd), 0) AS microUsd,
                COUNT(*) AS runs
           FROM executions e
           JOIN workflows w ON w.id = e.workflow_id
          WHERE w.workspace_id = ? AND e.created_at >= ? AND e.created_at <= ?
            AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')
          GROUP BY key
          ORDER BY key`
      )
      .all(workspaceId, start, end)
  }

  if (groupBy === 'nodeType') {
    // Step-level, because "which kind of work costs us money" is not derivable
    // from run totals — a run that mixes an AI call with fifty transforms
    // attributes all of its cost to the workflow, and none of it to a type.
    return db
      .prepare(
        `SELECT COALESCE(s.node_type, 'unknown') AS key,
                COALESCE(SUM(s.cost_micro_usd), 0) AS microUsd,
                COUNT(*) AS steps
           FROM execution_steps s
           JOIN executions e ON e.id = s.execution_id
           JOIN workflows w ON w.id = e.workflow_id
          WHERE w.workspace_id = ? AND e.created_at >= ? AND e.created_at <= ?
            AND s.cost_micro_usd IS NOT NULL
            AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')
          GROUP BY key
          ORDER BY microUsd DESC`
      )
      .all(workspaceId, start, end)
  }

  return db
    .prepare(
      `SELECT w.id AS key, w.name AS name,
              COALESCE(SUM(e.cost_micro_usd), 0) AS microUsd,
              COUNT(*) AS runs
         FROM executions e
         JOIN workflows w ON w.id = e.workflow_id
        WHERE w.workspace_id = ? AND e.created_at >= ? AND e.created_at <= ?
          AND (e.trigger_type IS NULL OR e.trigger_type != 'dry-run')
        GROUP BY w.id
        ORDER BY microUsd DESC`
    )
    .all(workspaceId, start, end)
}

module.exports = {
  DEFAULT_ALERT_PCT,
  currentMonth,
  budgetFor,
  spentThisMonth,
  budgetStatus,
  checkBudget,
  costBreakdown,
}
