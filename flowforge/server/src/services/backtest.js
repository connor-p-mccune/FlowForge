// Deploy preview — what a change would have done to the runs that already
// happened.
//
// Every gate on a deploy in this product is **static**. The linter asks whether
// the graph is well-formed, the type checker whether the data lines up, a
// policy whether the organisation permits it, a guarantee whether the author's
// own invariants still hold, path feasibility whether every branch is live. All
// five are worth having and none of them answers the question the person with
// their cursor over Deploy actually has:
//
//     what would this change have done to last week's traffic?
//
// A [canary](./canary.js) answers it, eventually, with real traffic and real
// consequences. This answers it beforehand against traffic that already
// happened, with none.
//
// ## The method
//
// For each of the last N real runs: take its recorded trigger payload, replay
// it against the **candidate** graph in dry-run mode, and compare the path it
// takes against the path the run really took.
//
// The load-bearing detail is what runs for real during that replay. A plain dry
// run replaces an HTTP call with a "would send" preview, so a condition
// branching on `status == 200` behaves differently for a reason that has
// nothing to do with the edit — the comparison would be dominated by test-mode
// artefacts. So every node whose work reaches outside FlowForge is **settled
// from the original run's own recorded output**, and what executes is exactly
// the graph's decision logic: conditions, switches, validate gates, filters,
// maps, transforms, aggregates.
//
// That makes a routing difference attributable to the change, which is the
// whole claim the feature makes.
//
// ## What it does not claim
//
// It answers *what does the graph do with the same data*, not *what does a
// different API return*. Point an HTTP node at a new URL and the preview keeps
// the old response, because nothing here can know the new one. Stated plainly
// rather than hidden, because a preview that quietly invented a response would
// be worse than no preview: its findings would look like the others.
//
// ## Boundaries
//
//   * **Dry-run only, structurally.** The engine refuses a graph override and
//     stubbed outputs outside a dry run, so a preview cannot fire a real
//     effect however it is called.
//   * **The runs are a means, not a record.** Each replay's execution row is
//     deleted once its steps have been read. A preview is a question, and
//     leaving fifty rows in history every time somebody asks one would make run
//     history useless — the opposite of what this exists for.
//   * **Bounded twice**, by run count and by wall time, because it is a
//     synchronous request that executes graphs.

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('./executionEngine')

// Node types whose runner reaches outside FlowForge or waits on something that
// does. These are settled from the original run rather than re-executed — not
// as an optimisation, but because re-executing them in test mode is exactly the
// artefact that would swamp the comparison.
//
// Transform, filter, map, aggregate, condition, switch and validate are
// deliberately absent: they are pure functions of their input and their config,
// which is the thing under test.
const STUBBED_TYPES = new Set([
  'action-http',
  'action-email',
  'action-slack',
  'action-delay',
  'ai-prompt',
  'ai-classify',
  'ai-extract',
  'sub-workflow',
  'for-each',
  'approval',
  'wait-callback',
])

const DEFAULT_RUNS = 20
const MAX_RUNS = 50

// Per-replay and whole-request ceilings. A workflow with a real delay node
// sleeps even in dry-run (the same reason test scenarios are bounded), and a
// preview that hangs a request is a preview nobody presses twice.
function runTimeoutMs() {
  const n = parseInt(process.env.PREVIEW_RUN_TIMEOUT_MS || '10000', 10)
  return Number.isFinite(n) && n > 0 ? n : 10000
}

function totalTimeoutMs() {
  const n = parseInt(process.env.PREVIEW_TOTAL_TIMEOUT_MS || '60000', 10)
  return Number.isFinite(n) && n > 0 ? n : 60000
}

function parseRunCount(value) {
  const n = parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUNS
  return Math.min(n, MAX_RUNS)
}

const parseJson = (text, fallback) => {
  if (text == null || text === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

// The runs worth replaying: real, settled, top-level. Failed runs are included
// on purpose — "the change makes this stop failing" is exactly as interesting
// as "the change makes this start failing", and excluding them would hide the
// half of the answer somebody is usually hoping for.
function recentRuns(workflowId, limit) {
  return db
    .prepare(
      `SELECT id, status, trigger_type, trigger_data, created_at
         FROM executions
        WHERE workflow_id = ?
          AND status IN ('completed', 'failed')
          AND parent_execution_id IS NULL
          AND (trigger_type IS NULL OR trigger_type != 'dry-run')
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(workflowId, limit)
}

// What a recorded run did, as the two things a comparison needs: which nodes
// ran (and how they routed), and what each of them produced.
function recordedRun(executionId) {
  const steps = db
    .prepare(
      `SELECT node_id, node_type, status, output_json
         FROM execution_steps
        WHERE execution_id = ?
        ORDER BY rowid`
    )
    .all(executionId)

  const path = []
  const outputs = {}
  for (const step of steps) {
    outputs[step.node_id] = parseJson(step.output_json, null)
    // 'skipped' is the engine's word for "a branch above this went the other
    // way", which is precisely what the comparison is about — so the path is
    // the nodes that *ran*, in the order their rows were created.
    if (step.status !== 'skipped' && step.status !== 'pending') path.push(step.node_id)
  }
  return { steps, path, outputs }
}

// The stub map for one replay: every node in the candidate graph whose type is
// externally-effectful and for which the original run recorded an output.
//
// A node the original run never reached has no stub and simply executes in
// dry-run mode — which is correct, since a graph change that routes traffic
// into a previously dark branch is one of the differences worth reporting, and
// there is no recorded answer to lend it.
function stubsFor(candidateNodes, recorded) {
  const stubs = {}
  for (const node of candidateNodes) {
    if (!STUBBED_TYPES.has(node.type)) continue
    const output = recorded.outputs[node.id]
    if (output && typeof output === 'object' && !Array.isArray(output)) stubs[node.id] = output
  }
  return stubs
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Replay one run against the candidate graph and return what it did.
//
// The execution row is deleted in a `finally`: the replay is a question, and a
// question should not leave a record. Steps cascade with it.
async function replay(workflow, source, graph, stubs) {
  const executionId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, trigger_data, created_at)
     VALUES (?, ?, 'pending', 'dry-run', ?, ?)`
  ).run(executionId, workflow.id, source.trigger_data ?? null, now)

  try {
    let timedOut = false
    let output = null
    try {
      output =
        (await withTimeout(
          runExecution(executionId, {
            dryRun: true,
            payload: parseJson(source.trigger_data, {}),
            publish: () => {},
            graphOverride: graph,
            stubs,
          }),
          runTimeoutMs()
        )) ?? null
    } catch (err) {
      if (/timed out/.test(err.message)) timedOut = true
      else throw err
    }

    const status = timedOut
      ? 'timed-out'
      : db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId)?.status ?? 'unknown'
    const { path, outputs } = recordedRun(executionId)
    return { status, path, outputs, output }
  } finally {
    db.prepare('DELETE FROM executions WHERE id = ?').run(executionId)
  }
}

// The difference between what a run did and what it would do, in the terms
// somebody would act on rather than as two blobs to eyeball.
function compare(before, after) {
  const beforeSet = new Set(before.path)
  const afterSet = new Set(after.path)
  const started = after.path.filter((id) => !beforeSet.has(id))
  const stopped = before.path.filter((id) => !afterSet.has(id))

  // Routing differences at the decision that caused them. A run whose switch
  // took a different case is one finding, not six — the nodes downstream of it
  // changing is the consequence, not a second problem.
  const routed = []
  for (const [nodeId, output] of Object.entries(after.outputs)) {
    const previous = before.outputs[nodeId]
    if (!previous || typeof previous !== 'object' || typeof output !== 'object') continue
    if (!('result' in previous) || !('result' in output)) continue
    if (JSON.stringify(previous.result) !== JSON.stringify(output.result)) {
      routed.push({ nodeId, before: previous.result, after: output.result })
    }
  }

  const statusChanged = before.status !== after.status
  return {
    identical: !statusChanged && started.length === 0 && stopped.length === 0 && routed.length === 0,
    statusChanged,
    started,
    stopped,
    routed,
  }
}

// Replay the last N runs against a candidate graph.
//
// Sequential rather than concurrent, deliberately: better-sqlite3 serialises
// writes anyway, and a preview competing with production traffic for the
// database is a strange way to find out whether an edit is safe.
async function previewDeploy(workflow, candidateGraph, { runs } = {}) {
  const limit = parseRunCount(runs)
  const sources = recentRuns(workflow.id, limit)
  if (sources.length === 0) {
    return {
      analysed: false,
      reason: 'no-runs',
      runs: 0,
      identical: 0,
      changed: [],
      summary: emptySummary(),
    }
  }

  const nodes = candidateGraph?.nodes || []
  const deadline = Date.now() + totalTimeoutMs()
  const changed = []
  let identical = 0
  let examined = 0
  let truncated = false

  for (const source of sources) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    const before = recordedRun(source.id)
    let after
    try {
      after = await replay(workflow, source, candidateGraph, stubsFor(nodes, before))
    } catch (err) {
      // One replay failing is data about that run, not a reason to abandon the
      // other nineteen.
      changed.push({
        executionId: source.id,
        at: source.created_at,
        error: err.message,
        difference: null,
      })
      examined++
      continue
    }

    examined++
    const difference = compare({ status: source.status, ...before }, after)
    if (difference.identical) {
      identical++
      continue
    }
    changed.push({
      executionId: source.id,
      at: source.created_at,
      before: { status: source.status, path: before.path },
      after: { status: after.status, path: after.path },
      difference,
    })
  }

  return {
    analysed: true,
    reason: null,
    runs: examined,
    // A preview that ran out of time has seen fewer runs than it was asked to,
    // and saying so is the difference between "nothing changed" and "we didn't
    // finish looking".
    truncated,
    identical,
    changed,
    summary: summarise(changed),
  }
}

const emptySummary = () => ({
  changed: 0,
  statusChanges: 0,
  routingChanges: 0,
  nodesStarted: [],
  nodesStopped: [],
  errors: 0,
})

function summarise(changed) {
  const started = new Set()
  const stopped = new Set()
  let statusChanges = 0
  let routingChanges = 0
  let errors = 0
  for (const entry of changed) {
    if (entry.error) {
      errors++
      continue
    }
    if (entry.difference.statusChanged) statusChanges++
    if (entry.difference.routed.length > 0) routingChanges++
    entry.difference.started.forEach((id) => started.add(id))
    entry.difference.stopped.forEach((id) => stopped.add(id))
  }
  return {
    changed: changed.length,
    statusChanges,
    routingChanges,
    nodesStarted: [...started],
    nodesStopped: [...stopped],
    errors,
  }
}

module.exports = {
  STUBBED_TYPES,
  DEFAULT_RUNS,
  MAX_RUNS,
  parseRunCount,
  recentRuns,
  recordedRun,
  stubsFor,
  compare,
  replay,
  previewDeploy,
}
