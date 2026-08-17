// Step-level idempotency keys — making a repeat of one node's request safe to
// send.
//
// Three mechanisms in this engine can execute the same logical step twice, and
// each of them is correct on its own terms:
//
//   * **Node retries** re-send after a timeout, and a timeout is exactly the
//     case where the far side may already have processed the request.
//   * **Resume-from-failure** re-runs everything downstream of the first node
//     that actually re-executed.
//   * **Crash recovery** re-runs a step whose outcome nobody recorded, and the
//     honest limit it documents is precisely this one: a step that was in flight
//     when the worker died may already have charged the card, so the `safe`
//     policy refuses to re-run it.
//
// FlowForge cannot make a third party idempotent. What it can do is send the
// header the third party is waiting for. Stripe, Adyen, GitHub, Shopify and
// most payment and provisioning APIs deduplicate on an `Idempotency-Key`; a
// workflow author who knows theirs does is currently unable to say so, and pays
// for it with a `manual` recovery policy on a workflow that never needed one.
//
// ## What the key is derived from, and why
//
// The key must be **the same** for every attempt at one logical step and
// **different** for a genuinely new request. That rules out the obvious
// candidates:
//
//   * the execution id alone — the same run's two HTTP nodes would collide;
//   * plus the attempt number — then a retry is a new request, which is the one
//     thing this exists to prevent;
//   * plus a timestamp or a random value — same problem, more expensively;
//   * plus a digest of the resolved config — a retry after a rotated secret
//     would change the key, and so would the identical request made a
//     millisecond later through a re-resolved template.
//
// What is left is `(logical run, node)`, and the interesting half is *logical*.
// A recovery or a resume creates a **new** execution row pointing back at the
// one it continues, so the key is derived from the **root** of that chain: the
// earliest execution the lineage reaches. A recovered run therefore presents the
// same key its predecessor did, which is the only way the far side can recognise
// the repeat.
//
// A run started fresh — a new webhook delivery, a new schedule tick — has itself
// as its root and gets a different key, which is correct: it is a different
// request, not a repeat.
//
// The key is a truncated SHA-256 rather than the ids themselves, for the reason
// the step cache hashes rather than stores: the value is sent to a third party,
// and an internal execution id is not something to hand out.

const crypto = require('crypto')
const db = require('../config/database')

// Cap on how far the resume/recovery chain is walked. A chain this long means
// something is retrying pathologically, and the cap keeps a corrupt row (a
// cycle, which the schema does not prevent) from spinning here.
const MAX_CHAIN = 32

// The header to send. Not configurable: `Idempotency-Key` is the de-facto
// standard (Stripe's spelling, adopted by the IETF's draft and by everyone
// else), and a per-node header name would be a setting whose only use is to
// paper over a service that does not implement the pattern — for which the
// answer is not to claim idempotency at all.
const HEADER = 'Idempotency-Key'

// Is this node asking for a key? Read from the **raw** config, like the
// `onError` and cache policies, so upstream data can never switch it on or off:
// whether a request is safe to repeat is a property of the endpoint, which is a
// static fact about the workflow rather than something a payload decides.
function isEnabled(node) {
  const value = node?.data?.config?.idempotent
  return value === true || value === 'true'
}

// The earliest execution in this run's resume/recovery lineage.
//
// Walks `resumed_from_execution_id`, which both the resume route and the
// recovery sweep set. Falls back to the execution itself at every failure — a
// missing row or a broken chain must yield *a* key rather than no key, because
// dropping the header would silently turn idempotency off on the one run that
// most needs it.
function rootExecutionId(executionId, { maxChain = MAX_CHAIN } = {}) {
  let current = executionId
  const seen = new Set([current])
  for (let i = 0; i < maxChain; i++) {
    let row
    try {
      row = db
        .prepare('SELECT resumed_from_execution_id AS parent FROM executions WHERE id = ?')
        .get(current)
    } catch {
      return current
    }
    if (!row?.parent || seen.has(row.parent)) return current
    seen.add(row.parent)
    current = row.parent
  }
  return current
}

// The key for one step of one logical run. Truncated to 32 hex characters:
// 128 bits of a SHA-256, which is far beyond collision concern for a value
// scoped to one workspace's traffic, and short enough to read in a log line.
function keyFor(rootId, nodeId) {
  return crypto
    .createHash('sha256')
    .update(`flowforge.step.v1|${rootId}|${nodeId}`)
    .digest('hex')
    .slice(0, 32)
}

// The header to add to a request, or null when the node has not asked for one.
//
// `ctx` carries the run's identity the way it already carries `traceparent`;
// a missing execution id means the node is being driven outside a run (the test
// bench), where there is no logical run to key on and therefore nothing honest
// to send.
function headerFor(node, ctx) {
  if (!isEnabled(node)) return null
  const executionId = ctx?.parentExecutionId
  const nodeId = ctx?.parentNodeId ?? node?.id
  if (!executionId || !nodeId) return null
  return { name: HEADER, value: keyFor(rootExecutionId(executionId), nodeId) }
}

module.exports = {
  HEADER,
  MAX_CHAIN,
  isEnabled,
  rootExecutionId,
  keyFor,
  headerFor,
}
