// Breakpoints: stop a run at a node, look at what it is about to do, change it,
// and continue.
//
// Everything else in FlowForge that helps you understand a run is a *record*.
// The timeline says where the wall time went, the run comparison says what
// changed since Tuesday, lineage says where a value came from. All of them
// answer questions after the fact, and none of them is any use for the question
// that actually stalls somebody: *why is this node about to send that?* The
// answer is a value assembled from six upstream outputs, two workspace
// variables and a secret, and by the time it appears in a step row the run has
// moved on and the interesting intermediate is gone.
//
// So the run stops and waits. A breakpoint pauses the node **after its config
// has been resolved and before its runner is called** — which is the only
// moment where both facts are available: what the node received, and what it is
// about to do with it.
//
// ## Breakpoints belong to a run, not to a workflow
//
// This is the design decision the whole feature rests on. A breakpoint is
// declared when a run is *started* and lives on the execution row, so there is
// no path by which a schedule tick, a webhook delivery, or an API trigger can
// hit one. Nobody can leave a breakpoint on a production workflow the way they
// can leave a `console.log`, because there is nowhere to leave it. That
// removes an entire category of rule — no scoping, no expiry, no owner-only
// widening, none of the machinery a chaos profile needs — by making the unsafe
// state unrepresentable rather than forbidden.
//
// ## Waiting is the approval pattern, deliberately
//
// The pause is a database row the engine polls, exactly like an approval gate.
// That is not reuse for its own sake: it means a paused run survives whatever
// the process does in between, the resume is a plain HTTP request from anywhere,
// and two people racing to resume the same break resolve to one winner inside
// the UPDATE. The engine already knows how to wait on a person.
//
// ## The timeout fails the run, and says why
//
// A paused node holds an execution slot and a worker. Somebody who walks away
// from a debug session should not wedge a queue, so the wait is bounded — and
// the bound *fails* the run rather than quietly continuing it. Continuing would
// mean a node ran with nobody watching, in a session whose entire purpose was
// that somebody was watching; failing says exactly what happened and leaves the
// run resumable from where it stopped.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')

const DEFAULT_TIMEOUT_MINUTES = 15
const MAX_BREAKPOINTS = 50

const ACTIONS = new Set(['continue', 'step', 'abort'])

// Read per call so a test can shrink the wait without re-requiring the module.
function pollIntervalMs() {
  const n = parseInt(process.env.DEBUG_POLL_MS || '500', 10)
  return Number.isFinite(n) && n >= 5 ? n : 500
}

function timeoutMs() {
  const n = parseInt(process.env.DEBUG_BREAK_TIMEOUT_MS || '', 10)
  if (Number.isFinite(n) && n > 0) return n
  return DEFAULT_TIMEOUT_MINUTES * 60 * 1000
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Validate a debug request from a run submission. Returns the stored shape, or
// null when the request asks for nothing — a run with no breakpoints and no
// step mode is an ordinary run, and recording an empty debug session on it
// would make history lie about how it was started.
function parseDebugRequest(request, graph) {
  if (!request || typeof request !== 'object') return null
  const known = new Set((graph?.nodes || []).map((n) => n.id))
  const breakpoints = Array.isArray(request.breakpoints)
    ? [...new Set(request.breakpoints.filter((id) => typeof id === 'string' && known.has(id)))].slice(
        0,
        MAX_BREAKPOINTS
      )
    : []
  // `stepFromStart` breaks at the first node and then at every node after it —
  // the "step into" you want when you do not yet know where the problem is.
  const stepFromStart = request.stepFromStart === true
  if (breakpoints.length === 0 && !stepFromStart) return null
  return { breakpoints, stepFromStart }
}

// The live plan for a run, or null when the run is not a debug session. Held in
// engine memory for the run's duration because `step` mutates it — an action
// taken at one break decides whether the *next* node stops, which is state
// about the session rather than about any one break.
function planFor(execution) {
  if (!execution?.debug_json) return null
  let parsed
  try {
    parsed = JSON.parse(execution.debug_json)
  } catch {
    return null
  }
  const breakpoints = new Set(parsed.breakpoints || [])
  let stepping = parsed.stepFromStart === true
  return {
    shouldBreak: (nodeId) => stepping || breakpoints.has(nodeId),
    // Applied when a break resolves: `step` arms the next node, anything else
    // disarms stepping and falls back to the declared breakpoints.
    apply: (action) => {
      stepping = action === 'step'
    },
    breakpoints,
  }
}

// Pause the run at a node and wait for somebody to resume it.
//
// `input` and `config` are the *resolved* values — what the node received and
// what it is about to do — and are persisted through the caller's redactor, so
// a paused break is exactly as safe to look at as a finished step row.
//
// Resolves to { action, override } where override may carry `config` and/or
// `input` patches to apply before the runner runs.
async function pauseAt({ executionId, node, input, config, redact, publish, isCancelled }) {
  const id = uuidv4()
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + timeoutMs()).toISOString()
  const safe = (value) => {
    try {
      return redact ? redact(JSON.stringify(value ?? null)) : JSON.stringify(value ?? null)
    } catch {
      return null
    }
  }

  db.prepare(
    `INSERT INTO execution_breaks
       (id, execution_id, node_id, node_label, status, input_json, config_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'paused', ?, ?, ?, ?)`
  ).run(id, executionId, node.id, node.data?.label || node.id, safe(input), safe(config), now, expiresAt)

  publish?.({
    kind: 'debug',
    executionId,
    breakId: id,
    nodeId: node.id,
    nodeLabel: node.data?.label || node.id,
    status: 'paused',
    input: input ?? null,
    config: config ?? null,
    expiresAt,
  })

  const read = db.prepare('SELECT * FROM execution_breaks WHERE id = ?')
  const deadline = Date.now() + timeoutMs()

  for (;;) {
    const row = read.get(id)
    if (row.status !== 'paused') {
      let override = null
      try {
        override = row.override_json ? JSON.parse(row.override_json) : null
      } catch {
        override = null
      }
      publish?.({
        kind: 'debug',
        executionId,
        breakId: id,
        nodeId: node.id,
        status: 'resumed',
        action: row.action,
      })
      return { action: row.action || 'continue', override }
    }

    // A cancelled run must not sit at a breakpoint waiting for a person who has
    // already decided. Settle the row so the panel never shows an orphan.
    if (isCancelled?.()) {
      db.prepare(
        "UPDATE execution_breaks SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'paused'"
      ).run(new Date().toISOString(), id)
      return { action: 'abort', override: null }
    }

    if (Date.now() > deadline) {
      db.prepare(
        "UPDATE execution_breaks SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'paused'"
      ).run(new Date().toISOString(), id)
      publish?.({
        kind: 'debug',
        executionId,
        breakId: id,
        nodeId: node.id,
        status: 'expired',
      })
      throw new Error(
        `[debugger] paused at "${node.data?.label || node.id}" and nobody resumed it within ${Math.round(
          timeoutMs() / 60000
        )} minutes`
      )
    }

    await sleep(pollIntervalMs())
  }
}

// Resume a paused break. The status guard lives inside the UPDATE, so two
// people pressing Continue at the same moment resolve to exactly one winner and
// the loser is told what the verdict was — the same rule an approval response
// follows.
// `executionId` scopes the write rather than being checked afterwards: a break
// id belonging to another run must never be resumed *and then* rejected, which
// is what a post-hoc ownership check would do.
function resumeBreak(breakId, { executionId, action = 'continue', override = null, userId = null } = {}) {
  if (!ACTIONS.has(action)) return { ok: false, error: 'Unknown debug action' }
  const row = db
    .prepare('SELECT * FROM execution_breaks WHERE id = ? AND execution_id = ?')
    .get(breakId, executionId)
  if (!row) return { ok: false, notFound: true }

  const patch = sanitizeOverride(override)
  const result = db
    .prepare(
      `UPDATE execution_breaks
          SET status = 'resumed', action = ?, override_json = ?, resolved_at = ?, resolved_by = ?
        WHERE id = ? AND execution_id = ? AND status = 'paused'`
    )
    .run(
      action, patch ? JSON.stringify(patch) : null, new Date().toISOString(), userId,
      breakId, executionId
    )

  if (result.changes === 0) {
    return { ok: false, alreadySettled: true, status: row.status, action: row.action }
  }
  return { ok: true }
}

// An override is a patch over what the node was about to use, so it is a shallow
// object of plain values and nothing else. Refusing anything larger is not
// paranoia about size: an override is applied to the config the engine already
// resolved, and letting it carry arbitrary nesting would make "what did this
// node actually run with" unanswerable from the recorded patch alone.
function sanitizeOverride(override) {
  if (!override || typeof override !== 'object') return null
  const pick = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null
    const out = {}
    for (const [key, value] of Object.entries(source)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
  }
  const config = pick(override.config)
  const input = pick(override.input)
  if (!config && !input) return null
  return { ...(config ? { config } : {}), ...(input ? { input } : {}) }
}

function listBreaks(executionId) {
  return db
    .prepare('SELECT * FROM execution_breaks WHERE execution_id = ? ORDER BY created_at ASC')
    .all(executionId)
    .map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      nodeLabel: row.node_label,
      status: row.status,
      action: row.action,
      input: safeParse(row.input_json),
      config: safeParse(row.config_json),
      override: safeParse(row.override_json),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
    }))
}

function safeParse(json) {
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

// A run that ends while a break is still open leaves the row dangling — the
// engine calls this on the way out so the panel never shows a pause that
// nothing is waiting on.
function settleOpenBreaks(executionId) {
  db.prepare(
    "UPDATE execution_breaks SET status = 'cancelled', resolved_at = ? WHERE execution_id = ? AND status = 'paused'"
  ).run(new Date().toISOString(), executionId)
}

module.exports = {
  parseDebugRequest,
  planFor,
  pauseAt,
  resumeBreak,
  listBreaks,
  settleOpenBreaks,
  sanitizeOverride,
  MAX_BREAKPOINTS,
}
