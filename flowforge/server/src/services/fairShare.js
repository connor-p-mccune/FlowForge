// Fair queueing between workflows.
//
// Run priority lanes decide the order *between* lanes: a `high` run is picked
// up before a `normal` one, always. Within a lane the queue is FIFO, and that
// is the hole.
//
// A workflow that submits five thousand runs — a webhook sender caught in a
// retry loop, a for-each fan-out over a list that grew, a schedule that
// unpaused into a backlog — puts five thousand jobs at the head of its lane.
// Every other workflow's *next* run now waits behind all of them. Nothing in
// the system is broken: the concurrency cap is respected, the rate limit is
// respected, the priority is respected. One tenant simply has the queue, and
// everybody else's automation has stopped.
//
// Priority and fairness are different questions, and the queue only answered
// the first. This answers the second, and answers it **within a lane**, so
// priority still dominates: a `high` run never waits on fairness with a
// `normal` one, because they are not competing for the same thing.
//
// ---------------------------------------------------------------------------
// The rule is max-min fairness, which is what deficit round robin approximates
// and what reads as a single sentence:
//
//   **You may start a run unless you are already more than `burst` runs ahead
//   of the workflow that has had the fewest — in which case you wait for them.**
//
// Three properties follow, and each is the answer to an obvious objection:
//
//   * **It costs nothing when nobody is waiting.** The comparison is against
//     workflows that have actually been deferred recently. With one workflow
//     running, the set is that workflow, the minimum is its own count, and the
//     check passes trivially. A fairness control that taxed an idle system
//     would be a latency regression sold as a feature.
//   * **It never drops work.** An unfair job is *re-parked*, through exactly
//     the mechanism the concurrency cap already uses — the Bull slot frees for
//     somebody else and this job comes back shortly, carrying its lane so a
//     deferral can never quietly demote it.
//   * **Fairness must not become starvation.** A job deferred too many times is
//     admitted regardless. A queue that is perfectly fair and never runs your
//     job is worse than one that is unfair, and the bound makes the worst case
//     a delay rather than a hang.
//
// In-memory per process, like the metrics registry and the retry budget: a
// fair-share counter that needed consensus between workers would be a
// distributed systems problem bolted onto a scheduling heuristic. Each worker
// is fair about the traffic it sees, which is the traffic it is deciding.

const { recordRunDeferred } = require('./metrics')

// Rolling window over which admissions are counted, in fixed buckets so expiry
// is a pointer move rather than a scan.
const BUCKETS = 6
const MAX_TRACKED = 500

const lanes = new Map() // lane -> { admitted: Map<wfId, ring>, waiting: Map<wfId, at> }

function enabled() {
  return process.env.DISABLE_FAIR_SHARE !== 'true'
}

const windowMs = () => {
  const n = parseInt(process.env.FAIR_SHARE_WINDOW_MS || '10000', 10)
  return Number.isFinite(n) && n >= 1000 ? n : 10000
}

// How far ahead of the least-served contender a workflow may get before it
// yields. Zero would be strict round robin and would ping-pong the queue on
// every job; a small burst lets a workflow make real progress while still
// bounding how far ahead it can run.
const burst = () => {
  const n = parseInt(process.env.FAIR_SHARE_BURST || '4', 10)
  return Number.isFinite(n) && n >= 1 ? n : 4
}

// After this many deferrals a job is admitted whatever the fair share says.
// See the note above: fairness that becomes starvation is the worse failure.
const maxDeferrals = () => {
  const n = parseInt(process.env.FAIR_SHARE_MAX_DEFERRALS || '20', 10)
  return Number.isFinite(n) && n >= 1 ? n : 20
}

function laneState(lane) {
  let state = lanes.get(lane)
  if (!state) {
    if (lanes.size >= MAX_TRACKED) lanes.delete(lanes.keys().next().value)
    state = { admitted: new Map(), waiting: new Map() }
    lanes.set(lane, state)
  }
  return state
}

function ringFor(state, workflowId, now) {
  let ring = state.admitted.get(workflowId)
  const span = windowMs() / BUCKETS
  if (!ring) {
    if (state.admitted.size >= MAX_TRACKED) {
      state.admitted.delete(state.admitted.keys().next().value)
    }
    ring = { buckets: new Array(BUCKETS).fill(0), index: 0, startedAt: now }
    state.admitted.set(workflowId, ring)
    return ring
  }
  const steps = Math.floor((now - ring.startedAt) / span)
  if (steps <= 0) return ring
  if (steps >= BUCKETS) {
    ring.buckets.fill(0)
    ring.index = 0
  } else {
    for (let i = 0; i < steps; i++) {
      ring.index = (ring.index + 1) % BUCKETS
      ring.buckets[ring.index] = 0
    }
  }
  ring.startedAt += steps * span
  return ring
}

const total = (ring) => ring.buckets.reduce((sum, n) => sum + n, 0)

// Workflows that have been deferred recently in this lane, i.e. the ones with
// work actually waiting. A workflow that stopped queueing ages out, so it stops
// constraining anybody — a contender set that only grew would eventually make
// every workflow look starved by one that went home.
function contendersIn(state, now) {
  const cutoff = now - windowMs()
  for (const [workflowId, at] of state.waiting) {
    if (at < cutoff) state.waiting.delete(workflowId)
  }
  return [...state.waiting.keys()]
}

// May this workflow start a run now?
//
//   lane        the run's priority lane — fairness is judged within one, so a
//               high-priority run never waits on a normal-priority one
//   deferrals   how many times this job has already been re-parked for fairness
//
// Returns `{ allowed }`, or `{ allowed: false, ahead, floor }` when the caller
// should re-park. Always allowed when disabled, so a caller can consult it
// unconditionally.
function admit(workflowId, { lane = 'normal', deferrals = 0 } = {}) {
  if (!enabled() || !workflowId) return { allowed: true }
  const now = Date.now()
  const state = laneState(lane)

  const contenders = contendersIn(state, now).filter((id) => id !== workflowId)
  // Nobody is waiting: fairness has nothing to be fair about, and taxing an
  // idle system would be a latency regression sold as a feature.
  if (contenders.length === 0) return { allowed: true }

  // Aging beats fairness. A queue that is perfectly fair and never runs your
  // job is worse than one that is unfair.
  if (deferrals >= maxDeferrals()) {
    return { allowed: true, aged: true }
  }

  const mine = total(ringFor(state, workflowId, now))
  let floor = mine
  for (const id of contenders) {
    const theirs = total(ringFor(state, id, now))
    if (theirs < floor) floor = theirs
  }

  if (mine < floor + burst()) return { allowed: true }
  return { allowed: false, ahead: mine - floor, floor, contenders: contenders.length }
}

// Record that a run of this workflow actually started. Called after admission
// rather than inside it, so a run refused by the concurrency cap or the budget
// downstream does not count against the workflow's share of a queue it never
// entered.
function recordStart(workflowId, lane = 'normal') {
  if (!enabled() || !workflowId) return
  const now = Date.now()
  const state = laneState(lane)
  const ring = ringFor(state, workflowId, now)
  ring.buckets[ring.index] += 1
  // Starting clears this workflow from the waiting set: it is no longer a
  // workflow with work stuck behind somebody else's.
  state.waiting.delete(workflowId)
}

// Record that a job was re-parked, which is what makes its workflow a
// contender the next comparison has to be fair to.
function recordDeferred(workflowId, lane = 'normal') {
  if (!enabled() || !workflowId) return
  laneState(lane).waiting.set(workflowId, Date.now())
  try {
    recordRunDeferred()
  } catch {
    /* metrics must never break admission */
  }
}

// Test hook: forget every lane so suites cannot leak state into each other.
function reset() {
  lanes.clear()
}

// Inspection, for a test or an operator asking why a run is waiting.
function snapshot(lane = 'normal') {
  const state = lanes.get(lane)
  if (!state) return { admitted: {}, waiting: [] }
  const now = Date.now()
  const admitted = {}
  // Through ringFor rather than reading the stored ring directly, so a stale
  // window is expired before it is reported — a snapshot that showed counts the
  // gate itself no longer sees would make an operator debug the wrong thing.
  for (const workflowId of [...state.admitted.keys()]) {
    admitted[workflowId] = total(ringFor(state, workflowId, now))
  }
  return { admitted, waiting: contendersIn(state, now) }
}

module.exports = { enabled, admit, recordStart, recordDeferred, reset, snapshot, BUCKETS }
