// Distributed tracing — W3C Trace Context in, OTLP spans out.
//
// FlowForge already answers "where did the time go?" *inside* a run: the
// timeline renders every step, and critical-path analysis names the chain that
// set the duration. What neither can see is everything on the other side of an
// HTTP node. When a workflow calls a service that calls two more, the run
// detail stops at "that step took 4 seconds" and the answer lives in somebody
// else's tracing backend, in a trace this run has no connection to.
//
// This module makes the run a participant in that trace rather than an opaque
// box beside it:
//
//   inbound   a webhook delivery carrying `traceparent` continues the caller's
//             trace — the run becomes a child span of whatever triggered it.
//   outbound  every HTTP node injects `traceparent` for its own step, so the
//             service it calls (and everything downstream of that) hangs off
//             the exact step that called it.
//   export    GET /api/executions/:id/trace emits OTLP/JSON — the wire format
//             an OpenTelemetry collector already accepts — so a run can be
//             pushed into Jaeger, Tempo, or Honeycomb without a translation
//             layer anyone has to maintain.
//
// Nothing here depends on an OpenTelemetry SDK. The parts actually needed are a
// 55-character header with a strict grammar and a JSON shape with a published
// schema; taking a tracing framework (and its instrumentation machinery, its
// context propagation, its shutdown semantics) to produce those two things
// would be a much larger commitment than writing them. Same call as the metrics
// registry and the cron engine.

const crypto = require('crypto')

// W3C traceparent: `version-traceId-spanId-flags`, all lowercase hex.
//   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

// All-zero ids are explicitly invalid in the spec — they are the "no trace"
// sentinel, and treating one as real would produce a trace nothing can join.
const INVALID_TRACE_ID = '0'.repeat(32)
const INVALID_SPAN_ID = '0'.repeat(16)

// The sampled flag (bit 0). A run FlowForge records is a run worth exporting,
// so anything it originates is marked sampled; an adopted context keeps the
// caller's decision instead, which is the whole point of the flag.
const FLAG_SAMPLED = 0x01

function newTraceId() {
  return crypto.randomBytes(16).toString('hex')
}

function newSpanId() {
  return crypto.randomBytes(8).toString('hex')
}

// Parse an inbound `traceparent`, or null if it isn't one we can safely join.
//
// Strict by design. A malformed header means the *caller* is confused, and
// adopting a half-understood context produces a trace that silently attaches
// runs to the wrong parent — worse than starting a fresh trace, which is what
// null tells the caller to do. Version `00` is the only one defined; the spec
// says a future version may be parsed leniently, but a version we've never seen
// carrying fields we don't understand is exactly the case where guessing hurts.
function parseTraceparent(header) {
  if (typeof header !== 'string') return null
  const match = TRACEPARENT.exec(header.trim().toLowerCase())
  if (!match) return null
  const [, version, traceId, spanId, flags] = match
  if (version !== '00') return null
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return null
  return {
    traceId,
    // The caller's span is *our* parent.
    parentSpanId: spanId,
    sampled: (parseInt(flags, 16) & FLAG_SAMPLED) === FLAG_SAMPLED,
  }
}

function formatTraceparent(traceId, spanId, sampled = true) {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`
}

// Nanoseconds since the epoch, as a string. OTLP uses fixed64 for timestamps,
// which JSON renders as a decimal string — and must, because 1e18 exceeds
// Number.MAX_SAFE_INTEGER and would quietly lose precision as a JS number.
// Recorded times only have millisecond resolution, so the tail is zeros; that
// is honest about the source rather than inventing precision.
function toUnixNano(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '0'
  return `${BigInt(ms) * 1_000_000n}`
}

// OTLP status codes: 0 unset, 1 ok, 2 error.
const STATUS = { UNSET: 0, OK: 1, ERROR: 2 }

// Step status → span status. `caught` is deliberately an error: the node really
// did fail, and a timeline that relabelled it would lie to whoever debugs it
// later — the same argument the engine makes for recording the distinct step
// status in the first place. `skipped` produces no span at all (nothing
// happened), which is handled by the caller.
function spanStatusFor(stepStatus) {
  if (stepStatus === 'failed' || stepStatus === 'caught') return STATUS.ERROR
  if (stepStatus === 'succeeded' || stepStatus === 'reused' || stepStatus === 'cached') {
    return STATUS.OK
  }
  return STATUS.UNSET
}

function attr(key, value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } }
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  return { key, value: { stringValue: String(value) } }
}

// Build the OTLP `ResourceSpans` payload for one run.
//
// Shape: one root span for the run, one child span per *executed* step. Skipped
// steps contribute nothing — a span means "this happened", and a dead branch
// didn't. Steps that never got a span id (rows written before tracing existed)
// get one derived deterministically from their step id, so a historical run
// still exports a coherent tree instead of a root with no children.
function buildTrace(execution, steps, workflow) {
  const traceId = execution.trace_id || deriveId(execution.id, 16)
  const rootSpanId = execution.root_span_id || deriveId(execution.id, 8)
  const startNano = toUnixNano(execution.started_at || execution.created_at)
  const endNano = toUnixNano(execution.finished_at || execution.started_at || execution.created_at)

  const rootStatus =
    execution.status === 'completed'
      ? STATUS.OK
      : execution.status === 'failed'
        ? STATUS.ERROR
        : STATUS.UNSET

  const spans = [
    {
      traceId,
      spanId: rootSpanId,
      // A run triggered by an inbound traceparent hangs off the caller's span;
      // otherwise this is a trace root and the field is omitted entirely (an
      // all-zero parent would be a lie about having one).
      ...(execution.parent_span_id ? { parentSpanId: execution.parent_span_id } : {}),
      name: workflow?.name ? `workflow ${workflow.name}` : 'workflow run',
      // SPAN_KIND_SERVER: the run is work performed in response to a trigger.
      kind: 2,
      startTimeUnixNano: startNano,
      endTimeUnixNano: endNano,
      attributes: [
        attr('flowforge.execution.id', execution.id),
        attr('flowforge.workflow.id', execution.workflow_id),
        attr('flowforge.workflow.name', workflow?.name),
        attr('flowforge.trigger.type', execution.trigger_type),
        attr('flowforge.execution.status', execution.status),
        attr('flowforge.execution.priority', execution.priority),
        // Cost rides the trace so a spend spike and a latency spike can be
        // looked at in one place, which is usually where the cause of both is.
        attr('flowforge.execution.cost_micro_usd', execution.cost_micro_usd),
      ].filter(Boolean),
      status: { code: rootStatus },
    },
  ]

  for (const step of steps) {
    if (step.status === 'skipped' || step.status === 'pending') continue
    const status = spanStatusFor(step.status)
    spans.push({
      traceId,
      spanId: step.span_id || deriveId(step.id, 8),
      parentSpanId: rootSpanId,
      name: `${step.node_type || 'node'} ${step.node_id}`,
      // SPAN_KIND_INTERNAL: a step is work inside the run. The *outbound* call
      // an HTTP node makes is a client span — but that span belongs to the
      // service on the other side of the wire, which creates it from the
      // traceparent this step injected.
      kind: 1,
      startTimeUnixNano: toUnixNano(step.started_at),
      endTimeUnixNano: toUnixNano(step.finished_at || step.started_at),
      attributes: [
        attr('flowforge.node.id', step.node_id),
        attr('flowforge.node.type', step.node_type),
        attr('flowforge.step.status', step.status),
        attr('flowforge.step.cost_micro_usd', step.cost_micro_usd),
      ].filter(Boolean),
      status: {
        code: status,
        // The error message is already secret-redacted on the step row — the
        // trace inherits that guarantee rather than re-deriving it.
        ...(status === STATUS.ERROR && step.error ? { message: step.error } : {}),
      },
    })
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', process.env.OTEL_SERVICE_NAME || 'flowforge'),
            attr('service.namespace', workflow?.workspace_id),
          ].filter(Boolean),
        },
        scopeSpans: [{ scope: { name: 'flowforge/execution-engine' }, spans }],
      },
    ],
  }
}

// A stable id derived from an existing uuid, for rows written before tracing
// existed. Deterministic so two exports of the same historical run agree —
// a trace whose ids changed per request would be useless to correlate.
function deriveId(sourceId, bytes) {
  return crypto
    .createHash('sha256')
    .update(String(sourceId))
    .digest('hex')
    .slice(0, bytes * 2)
}

module.exports = {
  FLAG_SAMPLED,
  STATUS,
  newTraceId,
  newSpanId,
  parseTraceparent,
  formatTraceparent,
  toUnixNano,
  spanStatusFor,
  buildTrace,
  deriveId,
}
