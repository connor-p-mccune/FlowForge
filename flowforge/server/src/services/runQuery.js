// Asking questions of run history, in the language the product already has.
//
// The insights, regressions and drift reports each answer one *fixed* question
// well. None of them answers the question somebody actually has during an
// incident, which is always specific and never the one anybody anticipated:
//
//     "which runs last week failed at the charge step with a 5xx,
//      for orders over a thousand?"
//
// Today that is a SQL prompt and a `json_extract` incantation, which means it
// is a question only somebody with database access can ask.
//
// So: **FXL is the query language.** The same expression language that powers
// condition nodes and the Filter node, evaluated against a scope describing one
// run. Nothing new to learn, no second syntax to keep consistent with the
// first, and every stdlib function — `lower`, `contains`, `len`, `matches` —
// works here because it is the same evaluator.
//
//     status == "failed" and steps.charge.output.status >= 500
//     durationMs > 60000 and trigger.order.total > 1000
//     lower(steps.notify.output.channel) in ["email", "sms"]
//
// ---
//
// ## The planner, and the one guarantee it rests on
//
// Scanning every run of a busy workflow to evaluate a predicate that could have
// been an indexed `WHERE status = 'failed'` is the difference between a query
// somebody uses and one they stop running. So conjuncts that map cleanly onto
// execution columns are **pushed into SQL**.
//
// Predicate pushdown is where query engines get subtly wrong answers, and the
// design here removes the risk rather than managing it:
//
// > **Every conjunct is evaluated by FXL regardless of whether it was pushed.**
// > The SQL clauses only ever narrow the candidate set. A pushdown bug can
// > therefore cost speed and can never change the answer.
//
// That turns soundness into a single obligation — *the SQL must never remove a
// row FXL would have kept* — and everything below is about discharging it.
//
// ### Why a naive pushdown would be wrong here
//
// FXL's comparison rules are its own, and they are not SQL's. `compare()` falls
// back to *string* comparison when either side is not numeric, so:
//
//     undefined >= 400     →  "undefined" >= "400"  →  **true**
//     null != "failed"     →  !looseEquals(…)       →  **true**
//
// A `WHERE json_extract(...) >= 400` would drop the first; `WHERE status !=
// 'failed'` drops the second, because SQL's `NULL != 'x'` is `NULL`. Both
// remove rows FXL keeps. So every emitted clause is widened with
// `OR <col> IS NULL`: one rule, applied uniformly, rather than a per-operator
// case analysis waiting to be got wrong.
//
// ### What is pushed, and what deliberately is not
//
//   * **Execution columns** — `status`, `triggerType`, `priority` and the three
//     timestamps — with the literal's type required to *match* the column's.
//     SQLite's type affinity makes `text_column > 20260801` unconditionally
//     true, which FXL does not agree with, so a number compared to a text
//     column is simply not pushed.
//   * **`durationMs`**, via julianday arithmetic, slackened by a millisecond to
//     absorb the float conversion — again a widening, again in the safe
//     direction.
//   * **Nothing under `trigger.` or `steps.`**, and not only for the coercion
//     reason above: the rows have to be loaded to evaluate those anyway, so
//     pushing them would add a correlated subquery for no saving.
//
// ### Positive position only
//
// A conjunct is pushable only when it sits on the top-level `and` spine.
// Underneath a `not`, an `or`, or a conditional, narrowing the candidate set is
// no longer the same as narrowing the result, and a clause that is a filter in
// one position is the opposite in another.
//
// ---
//
// ## One sharp edge, kept on purpose
//
// The same string fallback that makes the pushdown delicate is visible to the
// person writing the query:
//
//     steps.charge.output.status >= 500
//
// also matches every run that has **no charge step at all**, because
// `undefined >= 500` compares `"undefined"` against `"500"`. That is surprising
// the first time and it is not a bug to fix here: it is exactly what a
// condition node does with the same expression, and giving queries their own
// comparison rules would leave the product with two dialects of one language —
// a worse problem than a sharp edge that can be documented.
//
// The idiom is to say so, and FXL already has the operator: `in` on an object
// is a `hasOwnProperty` test.
//
//     "charge" in steps and steps.charge.output.status >= 500

const db = require('../config/database')
const { compile } = require('./expression')

// FXL identifier → the column it means, and the literal type that can be
// compared against it. Timestamps are ISO-8601 UTC strings, which compare
// lexicographically in exactly the order they compare chronologically.
const COLUMNS = {
  status: { sql: 'e.status', type: 'string' },
  triggerType: { sql: 'e.trigger_type', type: 'string' },
  priority: { sql: 'e.priority', type: 'string' },
  createdAt: { sql: 'e.created_at', type: 'string' },
  startedAt: { sql: 'e.started_at', type: 'string' },
  finishedAt: { sql: 'e.finished_at', type: 'string' },
  durationMs: {
    sql: '((julianday(e.finished_at) - julianday(e.started_at)) * 86400000)',
    type: 'number',
    // Float error in the julianday round-trip is well under a millisecond;
    // slackening the bound by one keeps the clause a strict widening.
    slack: 1,
  },
  waitMs: {
    sql: '((julianday(e.started_at) - julianday(e.created_at)) * 86400000)',
    type: 'number',
    slack: 1,
  },
}

const SQL_OPS = { '==': '=', '===': '=', '!=': '<>', '!==': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=' }
// Reversing a comparison when the literal is on the left.
const FLIP = { '=': '=', '<>': '<>', '<': '>', '<=': '>=', '>': '<', '>=': '<=' }

const isLiteral = (node) => node?.type === 'Literal'
const isIdentifier = (node) => node?.type === 'Identifier'

function typeOf(value) {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return null
}

// Widen a bound in the direction that can only admit more rows.
function slacken(op, value, slack) {
  if (!slack) return value
  if (op === '>' || op === '>=') return value - slack
  if (op === '<' || op === '<=') return value + slack
  return value
}

// One conjunct → a SQL clause, or null when it cannot be pushed soundly.
//
// The `OR … IS NULL` is the load-bearing part. Without it every operator would
// need its own argument about how SQL's three-valued logic lines up with FXL's
// coercions, and one of those arguments would eventually be wrong.
function clauseFor(node) {
  if (node?.type !== 'Binary') return null

  let identifier = null
  let literal = null
  let op = SQL_OPS[node.op]
  if (!op) return null

  if (isIdentifier(node.left) && isLiteral(node.right)) {
    identifier = node.left.name
    literal = node.right.value
  } else if (isLiteral(node.left) && isIdentifier(node.right)) {
    identifier = node.right.name
    literal = node.left.value
    op = FLIP[op]
  } else {
    return null
  }

  const column = COLUMNS[identifier]
  if (!column) return null
  // A number compared to a TEXT column is where SQLite's type affinity and
  // FXL's string fallback disagree outright, so it is not pushed at all.
  if (typeOf(literal) !== column.type) return null

  return {
    sql: `(${column.sql} ${op} ? OR ${column.sql} IS NULL)`,
    params: [slacken(node.op, literal, column.slack)],
    describe: `${identifier} ${node.op} ${JSON.stringify(literal)}`,
  }
}

// `status in ["failed", "cancelled"]` — the most useful operator here, and
// sound whenever every element matches the column's type.
function inClauseFor(node) {
  if (node?.type !== 'Binary' || node.op !== 'in') return null
  if (!isIdentifier(node.left) || node.right?.type !== 'Array') return null
  const column = COLUMNS[node.left.name]
  if (!column) return null

  const values = []
  for (const element of node.right.elements) {
    if (!isLiteral(element) || typeOf(element.value) !== column.type) return null
    values.push(element.value)
  }
  if (values.length === 0) return null

  return {
    sql: `(${column.sql} IN (${values.map(() => '?').join(', ')}) OR ${column.sql} IS NULL)`,
    params: values,
    describe: `${node.left.name} in ${JSON.stringify(values)}`,
  }
}

// The top-level `and` spine. Anything under a `not`, an `or` or a conditional
// is left alone: narrowing the candidate set there is not the same as narrowing
// the result.
//
// Only `&&` is matched because the lexer normalises the `and` keyword to it, so
// `a and b` and `a && b` are the same tree by the time the planner sees them.
function conjuncts(node, out = []) {
  if (node?.type === 'Logical' && node.op === '&&') {
    conjuncts(node.left, out)
    conjuncts(node.right, out)
    return out
  }
  out.push(node)
  return out
}

// Does the predicate mention `steps` at all? If not, the steps of every
// candidate run never need loading — which on a workflow with a dozen nodes is
// the difference between one query and thousands.
function referencesIdentifier(node, name) {
  if (!node || typeof node !== 'object') return false
  if (node.type === 'Identifier' && node.name === name) return true
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((v) => referencesIdentifier(v, name))) return true
    } else if (value && typeof value === 'object' && referencesIdentifier(value, name)) {
      return true
    }
  }
  return false
}

// → { clauses, params, pushed: [describe…], needsSteps, needsTrigger }
function planQuery(ast) {
  const clauses = []
  const params = []
  const pushed = []

  for (const conjunct of conjuncts(ast)) {
    const clause = clauseFor(conjunct) || inClauseFor(conjunct)
    if (!clause) continue
    clauses.push(clause.sql)
    params.push(...clause.params)
    pushed.push(clause.describe)
  }

  return {
    clauses,
    params,
    pushed,
    needsSteps: referencesIdentifier(ast, 'steps'),
    needsTrigger: referencesIdentifier(ast, 'trigger'),
  }
}

const parseJson = (text) => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const msBetween = (a, b) => {
  const start = a ? Date.parse(a) : NaN
  const end = b ? Date.parse(b) : NaN
  return Number.isFinite(start) && Number.isFinite(end) ? end - start : null
}

// One run, as the predicate sees it. Flat where flat reads better (`status`,
// `durationMs`) and nested where the data is (`trigger`, `steps`).
function scopeFor(row, steps) {
  const scope = {
    id: row.id,
    status: row.status,
    triggerType: row.trigger_type,
    priority: row.priority,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: msBetween(row.started_at, row.finished_at),
    waitMs: msBetween(row.created_at, row.started_at),
    trigger: parseJson(row.trigger_data) ?? {},
    steps: {},
  }
  for (const step of steps || []) {
    scope.steps[step.node_id] = {
      status: step.status,
      type: step.node_type,
      durationMs: msBetween(step.started_at, step.finished_at),
      error: step.error,
      input: parseJson(step.input_json) ?? {},
      output: parseJson(step.output_json) ?? {},
    }
  }
  return scope
}

// How many rows a single query may examine. A predicate the planner could not
// push is a full scan, and a full scan of a million runs inside a synchronous
// SQLite call is a stalled server. Reported as `truncated` rather than silently
// answered from a prefix.
const MAX_SCAN = 20000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function queryRuns(workflowId, source, { limit = DEFAULT_LIMIT, maxScan = MAX_SCAN } = {}) {
  let program
  try {
    program = compile(String(source ?? ''))
  } catch (err) {
    return { ok: false, error: err.message, position: err.position ?? null }
  }

  // Compiled once, evaluated per row — the same shape the Filter node uses.
  const plan = planQuery(program.ast)
  const capped = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT))

  const where = ['e.workflow_id = ?', ...plan.clauses]
  const rows = db
    .prepare(
      `SELECT e.id, e.status, e.trigger_type, e.priority, e.created_at, e.started_at,
              e.finished_at, e.trigger_data
       FROM executions e
       WHERE ${where.join(' AND ')}
       ORDER BY e.created_at DESC, e.rowid DESC
       LIMIT ?`
    )
    .all(workflowId, ...plan.params, maxScan + 1)

  const truncated = rows.length > maxScan
  const candidates = truncated ? rows.slice(0, maxScan) : rows

  const stepsFor = plan.needsSteps
    ? db.prepare(
        `SELECT node_id, node_type, status, error, input_json, output_json, started_at, finished_at
         FROM execution_steps WHERE execution_id = ?`
      )
    : null

  const matches = []
  let scanned = 0
  let errors = 0
  for (const row of candidates) {
    scanned += 1
    let keep = false
    try {
      keep = program.evaluateBoolean(scopeFor(row, stepsFor ? stepsFor.all(row.id) : null))
    } catch {
      // A predicate that throws on one run — a function given the wrong shape —
      // is a mismatch with that row, not a failed query. Counted so the caller
      // can tell "nothing matched" from "nothing could be evaluated".
      errors += 1
      continue
    }
    if (!keep) continue
    matches.push({
      id: row.id,
      status: row.status,
      triggerType: row.trigger_type,
      priority: row.priority,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: msBetween(row.started_at, row.finished_at),
      waitMs: msBetween(row.created_at, row.started_at),
    })
    if (matches.length >= capped) break
  }

  return {
    ok: true,
    runs: matches,
    plan: {
      // What the planner managed to turn into SQL, so a slow query explains
      // itself rather than requiring somebody to guess.
      pushedDown: plan.pushed,
      loadedSteps: plan.needsSteps,
      scanned,
      matched: matches.length,
      truncated,
      evaluationErrors: errors,
    },
  }
}

module.exports = { queryRuns, planQuery, scopeFor, COLUMNS, MAX_SCAN, MAX_LIMIT }
