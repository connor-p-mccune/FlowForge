// Distributed tracing: W3C trace context parsing, propagation into outbound
// calls, adoption from an inbound webhook, and the OTLP export.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')
const http = require('http')

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const tracing = require('../services/tracing')
const { runExecution } = require('../services/executionEngine')

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('parseTraceparent', () => {
  it('parses a valid header into the trace and the caller’s span', () => {
    expect(tracing.parseTraceparent(VALID)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      parentSpanId: '00f067aa0ba902b7',
      sampled: true,
    })
  })

  it('reads the sampled flag', () => {
    expect(tracing.parseTraceparent(VALID.replace(/-01$/, '-00')).sampled).toBe(false)
  })

  it('accepts an uppercase header by normalising it', () => {
    expect(tracing.parseTraceparent(VALID.toUpperCase()).traceId).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736'
    )
  })

  it('rejects all-zero ids, which are the spec’s "no trace" sentinel', () => {
    expect(tracing.parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull()
    expect(tracing.parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`)).toBeNull()
  })

  it('rejects a version it has never seen rather than guessing', () => {
    // A future version carries fields we don't understand; adopting it would
    // attach runs to a parent we can't actually verify.
    expect(tracing.parseTraceparent(VALID.replace(/^00/, '01'))).toBeNull()
  })

  it('rejects malformed input of every shape', () => {
    for (const bad of [
      '',
      'nonsense',
      null,
      undefined,
      42,
      '00-4bf92f-00f067aa0ba902b7-01', // short trace id
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // missing flags
      '00-4bf92f3577b34da6a3ce929d0e0e473g-00f067aa0ba902b7-01', // non-hex
    ]) {
      expect(tracing.parseTraceparent(bad)).toBeNull()
    }
  })
})

describe('formatTraceparent', () => {
  it('round-trips through the parser', () => {
    const traceId = tracing.newTraceId()
    const spanId = tracing.newSpanId()
    const parsed = tracing.parseTraceparent(tracing.formatTraceparent(traceId, spanId, true))
    expect(parsed).toEqual({ traceId, parentSpanId: spanId, sampled: true })
  })

  it('mints ids of the lengths the spec requires', () => {
    expect(tracing.newTraceId()).toMatch(/^[0-9a-f]{32}$/)
    expect(tracing.newSpanId()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('toUnixNano', () => {
  it('renders nanoseconds as a string, because the value exceeds a safe JS number', () => {
    const nano = tracing.toUnixNano('2026-08-06T12:00:00.000Z')
    expect(typeof nano).toBe('string')
    expect(nano).toBe('1786017600000000000')
    expect(Number(nano)).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
  })

  it('degrades to zero for an unusable timestamp', () => {
    expect(tracing.toUnixNano(null)).toBe('0')
    expect(tracing.toUnixNano('not a date')).toBe('0')
  })
})

describe('span status mapping', () => {
  it('treats a caught failure as an error, because the node really did fail', () => {
    expect(tracing.spanStatusFor('caught')).toBe(tracing.STATUS.ERROR)
    expect(tracing.spanStatusFor('failed')).toBe(tracing.STATUS.ERROR)
  })

  it('treats reused and cached steps as successes', () => {
    expect(tracing.spanStatusFor('succeeded')).toBe(tracing.STATUS.OK)
    expect(tracing.spanStatusFor('reused')).toBe(tracing.STATUS.OK)
    expect(tracing.spanStatusFor('cached')).toBe(tracing.STATUS.OK)
  })
})

describe('tracing through a real run', () => {
  let userId
  let workspaceId

  beforeAll(() => {
    userId = uuidv4()
    workspaceId = uuidv4()
    db.prepare(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'trace@example.com', 'x', 'T')"
    ).run(userId)
    db.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').run(
      workspaceId,
      'Trace WS',
      userId
    )
  })

  async function runGraph(nodes, edges = [], executionFields = {}) {
    const workflowId = uuidv4()
    const executionId = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Traced', ?, 'deployed', ?)`
    ).run(workflowId, workspaceId, JSON.stringify({ nodes, edges }), userId)

    const cols = ['id', 'workflow_id', 'status', 'trigger_type', 'created_at']
    const vals = [executionId, workflowId, 'pending', 'manual', new Date().toISOString()]
    for (const [k, v] of Object.entries(executionFields)) {
      cols.push(k)
      vals.push(v)
    }
    db.prepare(
      `INSERT INTO executions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    ).run(...vals)

    await runExecution(executionId, { publish: () => {} })
    return {
      workflowId,
      executionId,
      execution: db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId),
      steps: db.prepare('SELECT * FROM execution_steps WHERE execution_id = ?').all(executionId),
    }
  }

  const node = (id, type, config = {}) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, config },
  })

  it('mints a trace and a span per step', async () => {
    const { execution, steps } = await runGraph([
      node('t', 'trigger-manual'),
      node('x', 'transform', { expression: '{}' }),
    ], [{ id: 'e1', source: 't', target: 'x' }])

    expect(execution.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(execution.root_span_id).toMatch(/^[0-9a-f]{16}$/)
    expect(execution.parent_span_id).toBeNull() // a trace root
    for (const step of steps) {
      expect(step.span_id).toMatch(/^[0-9a-f]{16}$/)
    }
    // Every span id is distinct — a shared one would collapse the tree.
    expect(new Set(steps.map((s) => s.span_id)).size).toBe(steps.length)
  })

  it('adopts a trace it was given instead of minting a new one', async () => {
    const { execution } = await runGraph(
      [node('t', 'trigger-manual')],
      [],
      { trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7' }
    )
    expect(execution.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(execution.parent_span_id).toBe('00f067aa0ba902b7')
  })

  it('propagates the step’s trace context into an outbound HTTP call', async () => {
    // The whole point: the service on the other side records its work as a
    // child of the step that called it.
    const received = []
    const server = http.createServer((req, res) => {
      received.push(req.headers.traceparent)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`

    try {
      const { execution, steps } = await runGraph(
        [node('t', 'trigger-manual'), node('h', 'action-http', { url })],
        [{ id: 'e1', source: 't', target: 'h' }]
      )
      expect(received).toHaveLength(1)
      const parsed = tracing.parseTraceparent(received[0])
      expect(parsed.traceId).toBe(execution.trace_id)
      // The header names the *step's* span, not the run's — so the callee hangs
      // off the exact node rather than off the run as a whole.
      expect(parsed.parentSpanId).toBe(steps.find((s) => s.node_id === 'h').span_id)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('leaves an explicitly configured traceparent alone', async () => {
    // Someone hand-setting the header is deliberately joining another trace;
    // silently overwriting it would break the case they went out of their way
    // to build.
    const received = []
    const server = http.createServer((req, res) => {
      received.push(req.headers.traceparent)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`

    try {
      await runGraph(
        [
          node('t', 'trigger-manual'),
          node('h', 'action-http', { url, headers: JSON.stringify({ traceparent: VALID }) }),
        ],
        [{ id: 'e1', source: 't', target: 'h' }]
      )
      expect(received[0]).toBe(VALID)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('OTLP export', () => {
  let token
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'otlp@example.com', password: 'password123', displayName: 'O' })
    token = reg.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Traced flow' })
    workflowId = wf.body.workflow.id
  })

  function seedRun(fields = {}, steps = []) {
    const executionId = uuidv4()
    db.prepare(
      `INSERT INTO executions
         (id, workflow_id, status, trigger_type, trace_id, root_span_id, parent_span_id,
          started_at, finished_at, created_at, cost_micro_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      executionId,
      workflowId,
      fields.status || 'completed',
      'webhook',
      fields.trace_id ?? tracing.newTraceId(),
      fields.root_span_id ?? tracing.newSpanId(),
      fields.parent_span_id ?? null,
      '2026-08-06T12:00:00.000Z',
      '2026-08-06T12:00:04.000Z',
      '2026-08-06T12:00:00.000Z',
      fields.cost_micro_usd ?? 450
    )
    for (const step of steps) {
      db.prepare(
        `INSERT INTO execution_steps
           (id, execution_id, node_id, node_type, status, span_id, started_at, finished_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuidv4(),
        executionId,
        step.nodeId,
        step.nodeType,
        step.status,
        step.spanId ?? tracing.newSpanId(),
        step.startedAt ?? '2026-08-06T12:00:00.000Z',
        step.finishedAt ?? '2026-08-06T12:00:02.000Z',
        step.error ?? null
      )
    }
    return executionId
  }

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  it('emits a root span for the run with one child per executed step', async () => {
    const executionId = seedRun({}, [
      { nodeId: 't', nodeType: 'trigger-manual', status: 'succeeded' },
      { nodeId: 'h', nodeType: 'action-http', status: 'succeeded' },
      // Skipped steps produce no span: a span means "this happened", and a
      // dead branch didn't.
      { nodeId: 'dead', nodeType: 'output-log', status: 'skipped' },
    ])

    const res = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    expect(res.status).toBe(200)

    const spans = res.body.resourceSpans[0].scopeSpans[0].spans
    expect(spans).toHaveLength(3) // root + two executed steps
    const [root, ...children] = spans
    expect(root.name).toBe('workflow Traced flow')
    expect(root.kind).toBe(2) // SERVER
    expect(root.parentSpanId).toBeUndefined() // a trace root omits the field
    for (const child of children) {
      expect(child.parentSpanId).toBe(root.spanId)
      expect(child.traceId).toBe(root.traceId)
      expect(child.kind).toBe(1) // INTERNAL
    }
    expect(children.map((c) => c.name)).toEqual(['trigger-manual t', 'action-http h'])
  })

  it('parents the root span to the caller when the trace was adopted', async () => {
    const executionId = seedRun({ parent_span_id: '00f067aa0ba902b7' })
    const res = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    expect(res.body.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBe('00f067aa0ba902b7')
  })

  it('marks a failed step as an error span carrying its message', async () => {
    const executionId = seedRun({ status: 'failed' }, [
      { nodeId: 'h', nodeType: 'action-http', status: 'failed', error: 'HTTP 500: upstream down' },
    ])
    const res = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    const spans = res.body.resourceSpans[0].scopeSpans[0].spans
    expect(spans[0].status.code).toBe(2)
    expect(spans[1].status).toEqual({ code: 2, message: 'HTTP 500: upstream down' })
  })

  it('carries run attributes an operator would filter on, including cost', async () => {
    const executionId = seedRun({ cost_micro_usd: 1234 })
    const res = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    const attrs = Object.fromEntries(
      res.body.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a) => [
        a.key,
        Object.values(a.value)[0],
      ])
    )
    expect(attrs['flowforge.execution.id']).toBe(executionId)
    expect(attrs['flowforge.trigger.type']).toBe('webhook')
    // Cost on the trace means a spend spike and a latency spike are one query.
    expect(attrs['flowforge.execution.cost_micro_usd']).toBe('1234')
  })

  it('renders timestamps as nanosecond strings', async () => {
    const executionId = seedRun()
    const res = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    const root = res.body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(root.startTimeUnixNano).toBe('1786017600000000000')
    expect(root.endTimeUnixNano).toBe('1786017604000000000')
  })

  it('still exports a coherent tree for a run recorded before tracing existed', async () => {
    // Ids are derived deterministically from the row ids, so a historical run
    // exports as one trace rather than a root with orphaned children — and two
    // exports of it agree, which is the whole point of correlating.
    const executionId = seedRun({ trace_id: null, root_span_id: null }, [
      { nodeId: 't', nodeType: 'trigger-manual', status: 'succeeded', spanId: null },
    ])
    const first = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    const second = await authed(request(app).get(`/api/executions/${executionId}/trace`))
    const spansA = first.body.resourceSpans[0].scopeSpans[0].spans
    const spansB = second.body.resourceSpans[0].scopeSpans[0].spans

    expect(spansA[0].traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(spansA[1].parentSpanId).toBe(spansA[0].spanId)
    expect(spansB).toEqual(spansA)
  })

  it('404s a run in a workspace the caller is not a member of', async () => {
    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'trace-stranger@example.com', password: 'password123', displayName: 'S' })
    const executionId = seedRun()
    const res = await request(app)
      .get(`/api/executions/${executionId}/trace`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
    expect(res.status).toBe(404)
  })
})
