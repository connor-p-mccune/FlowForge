// Compensating transactions — the undo half of a run.
//
// Every reliability control in FlowForge bounds *whether* something runs.
// Retries re-attempt it, the circuit breaker stops calling a dead host, an
// on-error branch routes around a failure, an error-handler workflow escalates
// it, pause refuses new work. Not one of them undoes what already happened. A
// run that reserves inventory at step 2, charges a card at step 4 and fails at
// step 7 leaves the reservation and the charge standing, and the only thing the
// platform offers is a red badge in the history list.
//
// That gap is exactly what the saga pattern exists for: a long-lived
// transaction that cannot hold a lock across its steps instead pairs each step
// with a **compensating action**, and unwinds by running them backwards. This
// module is FlowForge's version of that, expressed the way everything else here
// is expressed — on the canvas.
//
// **A compensation is a node.** Drop any action node, set its `compensates`
// field to the id of the node it undoes, and it becomes that node's compensating
// action: a Refund Charge HTTP node compensating Charge Card, a
// Release Inventory sub-workflow compensating Reserve Inventory. It is a real
// node with real config, so it gets the linter, the type checker, the data
// picker, secrets, the test bench and the node library for free. Nothing about
// it is a new concept the author has to learn.
//
// **A compensation is not part of the forward graph.** It has no incoming
// edges and never appears in the topological order — the engine strips
// compensation nodes before it builds the DAG, the same way it strips sticky
// notes. They execute only during a rollback, one at a time, following no
// edges. That is why a compensation node may not be a trigger (nothing to
// trigger) or a branching node (its handles would route nowhere).
//
// Five decisions define the semantics.
//
// **Reverse completion order, not reverse topological order.** A DAG's topology
// says what *may* run in parallel; it does not say what actually finished
// first, and with `EXEC_MAX_PARALLEL > 1` two independent branches genuinely
// interleave. Undoing in an order the run never happened in is how you release
// a resource that a later step is still holding. So the engine records the real
// completion sequence and rollback walks it backwards.
//
// **Rollback is sequential, always.** The forward pass is parallel because
// throughput matters and the DAG proves independence. Rollback runs one
// compensation at a time even where the graph would permit otherwise, because
// the failure mode is not slowness — it is a half-undone state, and
// interleaving undos is the direct route to one. A rollback is bounded by the
// number of steps that already succeeded, so the cost is small and paid once.
//
// **A step that did no work this run is not compensated.** `cached` and
// `reused` steps adopted an output that some *earlier* run produced; this run
// never made the call. Compensating one would undo work a different execution
// did and still holds — a data-loss bug wearing a safety feature's clothes. A
// `caught` step is skipped for the mirror-image reason: it did not succeed, and
// its author already declared what its failure means by choosing `continue` or
// `branch`.
//
// **A failing compensation does not stop the rollback.** The run has already
// failed; there is no worse status to reach, and stopping would strand every
// remaining compensation — the ones *further back*, protecting the earliest and
// usually most expensive side effects. So a compensation that exhausts its
// retries is recorded, the rollback continues, and the run is marked `partial`
// rather than `completed`. Partial is a distinct, visible, actionable state:
// it names exactly which compensations are outstanding, and a manual rollback
// retries only those.
//
// **Re-running a rollback resumes it; it never repeats it.** Compensations are
// required to be idempotent in the literature and are frequently not in
// practice, so the manual rollback endpoint runs only the compensations that
// have never succeeded. Double-refunding a customer while trying to clean up
// after a failure is a worse outcome than the failure.

const COMPENSATION_STATUSES = ['succeeded', 'failed']

// How a workflow responds to a run that ends badly.
//
//   'failure'            — unwind a failed run (the default, and the case the
//                          saga pattern is about).
//   'failure-or-cancel'  — also unwind a cancelled one. Cancellation is a
//                          deliberate human stop, and whether "stop" means
//                          "leave it where it is" or "put it back" is genuinely
//                          a property of the workflow: abandoning a half-done
//                          deploy differs from abandoning a half-done report.
//   'off'                — the operator kill switch. Compensations stay drawn
//                          on the canvas and stop executing, which is what you
//                          want at 3am when the compensating endpoint is the
//                          thing that is broken.
const ROLLBACK_POLICIES = ['failure', 'failure-or-cancel', 'off']
const DEFAULT_ROLLBACK_POLICY = 'failure'

// A compensation may not be a trigger (it has no payload to emit and nothing
// triggers it) and may not be a branching node: rollback follows no edges, so a
// node whose entire purpose is selecting an outgoing handle would settle a
// routing decision nobody reads. Both are refused by the linter rather than
// silently ignored — a compensation that quietly never runs is the one failure
// mode this feature cannot afford.
const NON_COMPENSATING_TYPES = new Set([
  'condition',
  'switch',
  'validate',
  'approval',
  'wait-callback',
  'note',
])

function isCompensationCandidate(nodeType) {
  return (
    typeof nodeType === 'string' &&
    !nodeType.startsWith('trigger-') &&
    !NON_COMPENSATING_TYPES.has(nodeType)
  )
}

// The id a node declares it compensates, or null. Read from the raw config and
// never templated: which node this undoes is a static structural fact, and
// letting upstream data decide it would make the rollback plan depend on the
// run it is unwinding.
function compensatesId(node) {
  const raw = node?.data?.config?.compensates
  if (raw == null) return null
  const id = String(raw).trim()
  return id === '' ? null : id
}

// Split a graph's nodes into the forward set and the compensation set.
//
// `byTarget` maps a target node id to the single compensation node that undoes
// it. When two nodes claim the same target the *first in document order* wins
// and the rest are reported as duplicates — the linter turns that into an error,
// because "which of these two refunds runs?" has no defensible answer and
// picking one silently would make the other look armed when it isn't.
function compensationPlan(nodes = []) {
  const ids = new Set(nodes.map((n) => n.id))
  const byTarget = new Map()
  const compensationIds = new Set()
  const duplicates = []
  const dangling = []
  const invalidType = []

  for (const node of nodes) {
    const target = compensatesId(node)
    if (!target) continue
    compensationIds.add(node.id)
    if (!isCompensationCandidate(node.type)) {
      invalidType.push({ node, target })
      continue
    }
    if (!ids.has(target)) {
      dangling.push({ node, target })
      continue
    }
    if (byTarget.has(target)) {
      duplicates.push({ node, target, winner: byTarget.get(target) })
      continue
    }
    byTarget.set(target, node)
  }

  // A compensation that compensates a compensation is nonsense the plan must
  // not carry: the rollback pass never records compensations as completed
  // steps, so the inner one could never fire. Dropped here and reported by the
  // linter.
  const chained = []
  for (const [target, node] of [...byTarget.entries()]) {
    if (compensationIds.has(target)) {
      chained.push({ node, target })
      byTarget.delete(target)
    }
  }

  return { byTarget, compensationIds, duplicates, dangling, invalidType, chained }
}

// The forward graph: nodes and edges with every compensation node (and any edge
// touching one) removed. Compensation nodes are disconnected by construction,
// so the edge filter only matters for a hand-edited import — the same defensive
// posture the engine already takes with sticky notes.
function stripCompensations(nodes = [], edges = [], compensationIds) {
  const strip = compensationIds || compensationPlan(nodes).compensationIds
  return {
    nodes: nodes.filter((n) => !strip.has(n.id)),
    edges: edges.filter((e) => !strip.has(e.source) && !strip.has(e.target)),
  }
}

function rollbackPolicy(workflow) {
  const stored = workflow?.rollback_policy
  return ROLLBACK_POLICIES.includes(stored) ? stored : DEFAULT_ROLLBACK_POLICY
}

// Does a run ending in `status` unwind under this policy?
function shouldRollback(policy, status) {
  if (policy === 'off') return false
  if (status === 'failed') return true
  return status === 'cancelled' && policy === 'failure-or-cancel'
}

// The compensations to run, in the order to run them.
//
// `completed` is the run's real completion sequence — node ids in the order
// their steps finished, recorded by the engine as each one settled. Walking it
// backwards and keeping the entries that have a compensation gives the saga's
// unwind order directly. `already` names compensations that have previously
// succeeded (a manual rollback resuming a partial one); they are dropped rather
// than re-run.
function rollbackSequence(completed, byTarget, { already } = {}) {
  const done = already instanceof Set ? already : new Set(already || [])
  const plan = []
  for (let i = completed.length - 1; i >= 0; i--) {
    const targetId = completed[i]
    const node = byTarget.get(targetId)
    if (!node || done.has(targetId)) continue
    plan.push({ node, targetId })
  }
  return plan
}

// The rollback's verdict. `partial` exists as a status of its own because
// "some of the undo worked" is operationally different from both success and
// failure: the state is inconsistent in a *known, enumerated* way, and the
// remaining compensations can be retried without repeating the ones that took.
function rollbackOutcome(results) {
  if (results.length === 0) return null
  return results.every((r) => r.status === 'succeeded') ? 'completed' : 'partial'
}

module.exports = {
  compensationPlan,
  compensatesId,
  stripCompensations,
  isCompensationCandidate,
  rollbackPolicy,
  shouldRollback,
  rollbackSequence,
  rollbackOutcome,
  ROLLBACK_POLICIES,
  DEFAULT_ROLLBACK_POLICY,
  COMPENSATION_STATUSES,
  NON_COMPENSATING_TYPES,
}
