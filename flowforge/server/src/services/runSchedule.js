// Where a finished run's time actually went — work, or waiting for a slot.
//
// The critical path answers "which chain of steps set this run's duration",
// which is the right question for a machine with a free slot always available.
// Under `EXEC_MAX_PARALLEL` it can be badly wrong, and wrong in a way that reads
// as correct: a run of twelve independent one-second nodes at a cap of four has
// a one-second critical path, takes three seconds, and the timeline shows twelve
// bars starting in three tidy waves with nothing anywhere explaining the waves.
//
// This is the missing account, and it is **measured rather than simulated**. The
// step rows already contain everything needed: a node's `started_at`, and the
// `finished_at` of the predecessors it was waiting on. The difference between
// when a node *could* have started and when it *did* is queueing, and it is a
// fact about the run rather than a model of it.
//
//   analyzeRun(graph, steps) → {
//     makespanMs      wall time from the first step starting to the last finishing
//     workMs          time slots were actually occupied
//     queuedMs        time nodes sat ready with no slot free
//     utilisation     workMs ÷ (makespanMs × cap)
//     perNode         { nodeId: { startMs, finishMs, readyMs, queuedMs, cause } }
//     chain           the back-chain that set the makespan, each link labelled
//   }
//
// A node's `cause` names what it was waiting for, and the interesting case is
// when that is not one of its predecessors. If a node was ready at 1.2s and
// started at 4.0s it was not waiting for data — it was waiting for whichever
// node released a slot at 4.0s, which may be on a completely unrelated branch.
// That relationship has no edge in the graph, so nothing that reasons about the
// graph could ever report it; the observed timeline can.
//
// Pure: plain functions over a graph and the step rows. `routes/executions.js`
// supplies both, and `scheduleSim.js` supplies the counterfactuals ("what would
// this run have taken at a cap of eight?") from the same observed durations.

// Statuses whose step occupied an execution slot. Deliberately narrower than
// `criticalPath.js`'s set: a `reused` step adopts an earlier run's output and a
// `cached` one adopts the cache's, and both settle synchronously inside the
// scheduling round without ever entering `inFlight`. They took no capacity, so
// counting them as work would inflate utilisation and invent contention that did
// not happen. `caught` did occupy a slot — the node ran and failed, and its
// on-error policy decided what that meant afterwards.
const OCCUPIED_STATUSES = new Set(['succeeded', 'failed', 'caught'])

// Statuses that settle a node for the purpose of *readiness*. Wider than the
// set above, because a downstream node waits for its predecessor to settle
// however it settles — including instantly, from the cache.
const SETTLED_STATUSES = new Set(['succeeded', 'failed', 'caught', 'reused', 'cached', 'skipped'])

const parse = (value) => {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

// Predecessor lists over the graph, de-duplicated and self-loop free, in the
// shape the rest of the codebase builds them.
function predecessorsOf(graph, known) {
  const preds = new Map()
  for (const id of known) preds.set(id, [])
  const seen = new Set()
  for (const e of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!preds.has(e.source) || !preds.has(e.target)) continue
    if (e.source === e.target) continue
    const key = `${e.source} ${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    preds.get(e.target).push(e.source)
  }
  return preds
}

function analyzeRun(graph, steps, options = {}) {
  const rows = (Array.isArray(steps) ? steps : []).filter(
    (s) => SETTLED_STATUSES.has(s.status) && parse(s.started_at) !== null
  )
  const empty = {
    available: false,
    makespanMs: 0,
    workMs: 0,
    queuedMs: 0,
    utilisation: null,
    perNode: {},
    chain: [],
  }
  if (rows.length === 0) return empty

  // Everything is expressed relative to the first step that started, so the
  // numbers read as offsets into the run rather than as epoch milliseconds.
  let origin = Infinity
  for (const s of rows) origin = Math.min(origin, parse(s.started_at))

  const started = new Map()
  const finished = new Map()
  const occupied = new Set()
  for (const s of rows) {
    const start = parse(s.started_at) - origin
    const end = parse(s.finished_at)
    started.set(s.node_id, start)
    finished.set(s.node_id, end === null ? start : end - origin)
    if (OCCUPIED_STATUSES.has(s.status)) occupied.add(s.node_id)
  }

  const preds = predecessorsOf(graph, [...started.keys()])

  // When each node's data dependencies were satisfied: the last of its
  // predecessors to finish. A source is ready at 0.
  const readyAt = new Map()
  const dataBlocker = new Map()
  for (const id of started.keys()) {
    let ready = 0
    let blocker = null
    for (const p of preds.get(id) || []) {
      const f = finished.get(p)
      if (f == null) continue
      if (f > ready) {
        ready = f
        blocker = p
      }
    }
    readyAt.set(id, ready)
    dataBlocker.set(id, blocker)
  }

  // Which node released the slot this one took: among the nodes that occupied a
  // slot and finished at or before this node started, the latest to finish. An
  // inference from the observed timeline, and the only one available — the
  // engine does not record which slot went to whom, and it does not need to,
  // because "the most recent completion before I started" is what freed it.
  const occupiedFinishes = [...occupied]
    .map((id) => ({ id, at: finished.get(id) }))
    .sort((a, b) => a.at - b.at)

  const slotBlockerFor = (id, startMs) => {
    let chosen = null
    for (const entry of occupiedFinishes) {
      if (entry.id === id) continue
      if (entry.at > startMs) break
      chosen = entry.id
    }
    return chosen
  }

  // A step's timestamps are second- or millisecond-resolution strings, and two
  // nodes launched in the same scheduling round can differ by a millisecond of
  // bookkeeping. Anything under this is rounding, not queueing.
  const QUEUE_FLOOR_MS = Number.isFinite(options.queueFloorMs) ? options.queueFloorMs : 5

  let makespanMs = 0
  let workMs = 0
  let queuedMs = 0
  let last = null
  const perNode = {}
  for (const [id, start] of started) {
    const finish = finished.get(id)
    const ready = readyAt.get(id)
    const queued = Math.max(0, start - ready)
    const counted = occupied.has(id) ? queued : 0
    if (occupied.has(id)) workMs += Math.max(0, finish - start)
    if (counted > QUEUE_FLOOR_MS) queuedMs += counted

    let cause = null
    if (counted > QUEUE_FLOOR_MS) {
      const blocker = slotBlockerFor(id, start)
      if (blocker) cause = { nodeId: blocker, kind: 'slot' }
    }
    if (!cause && dataBlocker.get(id)) cause = { nodeId: dataBlocker.get(id), kind: 'data' }

    perNode[id] = {
      startMs: start,
      finishMs: finish,
      readyMs: ready,
      queuedMs: counted > QUEUE_FLOOR_MS ? counted : 0,
      durationMs: Math.max(0, finish - start),
      occupiedSlot: occupied.has(id),
      cause,
    }
    if (last === null || finish >= makespanMs) {
      makespanMs = finish
      last = id
    }
  }

  const chain = []
  const visited = new Set()
  for (let id = last; id != null && !visited.has(id); ) {
    visited.add(id)
    const n = perNode[id]
    chain.push({
      nodeId: id,
      startMs: n.startMs,
      finishMs: n.finishMs,
      queuedMs: n.queuedMs,
      durationMs: n.durationMs,
      waitedFor: n.cause ? n.cause.kind : null,
      blockedBy: n.cause ? n.cause.nodeId : null,
    })
    id = n.cause ? n.cause.nodeId : null
  }
  chain.reverse()

  const cap = Number.isFinite(options.cap) && options.cap > 0 ? options.cap : null
  return {
    available: true,
    makespanMs,
    workMs,
    queuedMs,
    // Null rather than a number when the cap is unknown: utilisation against an
    // assumed denominator is a statistic that looks precise and is not.
    utilisation: cap && makespanMs > 0 ? workMs / (makespanMs * cap) : null,
    perNode,
    chain,
  }
}

// The observed duration of each node that occupied a slot — the weights for
// asking what this same run would have taken under a different cap.
function observedDurations(analysis) {
  const durations = {}
  for (const [id, n] of Object.entries(analysis.perNode || {})) {
    if (n.occupiedSlot) durations[id] = n.durationMs
  }
  return durations
}

module.exports = {
  analyzeRun,
  observedDurations,
  OCCUPIED_STATUSES,
  SETTLED_STATUSES,
}
