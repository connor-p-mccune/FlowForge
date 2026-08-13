// Breakpoints, end to end through the real engine.
//
// The tests that matter are the ones about *when* the run stops and what it can
// see there, because a debugger that pauses in the wrong place is worse than
// none: it shows you a value the node was never going to use. So the pause is
// asserted to happen after config resolution (the `{{…}}` are substituted) and
// before the runner is called (the side effect has not happened).
//
// The safety property gets its own case. A breakpoint lives on the run, never
// on the workflow, which is what makes it impossible for a schedule tick to hit
// one — and that is worth a test precisely because it is a property of where
// data is stored rather than of any code path.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.DEBUG_POLL_MS = '10'

// A recording runner stands in for the HTTP node, so "did the side effect
// happen yet?" is directly observable at the moment the run is paused.
jest.mock('../services/nodeRunners/httpRequest', () =>
  jest.fn(async (config) => ({ status: 200, body: { ok: true, url: config.url } }))
)

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const httpRequest = require('../services/nodeRunners/httpRequest')
const { runExecution } = require('../services/executionEngine')
const {
  parseDebugRequest,
  resumeBreak,
  listBreaks,
  sanitizeOverride,
} = require('../services/debugger')

const userId = uuidv4()
const workspaceId = uuidv4()

// What the HTTP runner was actually called with, in order.
const calls = () => httpRequest.mock.calls.map(([config]) => config)

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const GRAPH = {
  nodes: [
    node('t1', 'trigger-manual', {}, 'Start'),
    node('h1', 'action-http', { url: 'https://api.example.com/{{t1.orderId}}', method: 'GET' }, 'Fetch'),
    node('o1', 'output-log', { message: 'done' }, 'Log'),
  ],
  edges: [edge('t1', 'h1'), edge('h1', 'o1')],
}

function makeWorkflow(graph = GRAPH) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, workspaceId, 'Debuggable', JSON.stringify(graph), 'deployed', userId, now, now)
  return id
}

function makeRun(workflowId, debug, triggerType = 'manual') {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, debug_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, workflowId, 'pending', userId, triggerType, debug ? JSON.stringify(debug) : null, now)
  return id
}

const stepFor = (executionId, nodeId) =>
  db
    .prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?')
    .get(executionId, nodeId)

// Poll until a break row appears, then hand it back. The engine is running
// concurrently in the same process, so this is how a test plays the part of the
// person sitting in front of the panel.
async function waitForBreak(executionId, previous = 0) {
  for (let i = 0; i < 400; i++) {
    const rows = db
      .prepare("SELECT * FROM execution_breaks WHERE execution_id = ? AND status = 'paused'")
      .all(executionId)
    const all = db.prepare('SELECT COUNT(*) AS n FROM execution_breaks WHERE execution_id = ?').get(executionId)
    if (rows.length > 0 && all.n > previous) return rows[rows.length - 1]
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('The run never paused')
}

beforeAll(() => {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'dbg@example.com', 'x', 'Dbg', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

beforeEach(() => {
  httpRequest.mockClear()
})

describe('parsing a debug request', () => {
  it('keeps only breakpoints that name a node in the graph', () => {
    expect(parseDebugRequest({ breakpoints: ['h1', 'ghost', 'o1'] }, GRAPH)).toEqual({
      breakpoints: ['h1', 'o1'],
      stepFromStart: false,
    })
  })

  it('returns null when nothing was asked for', () => {
    // A run with no breakpoints and no step mode is an ordinary run; recording
    // an empty debug session on it would make history lie about how it started.
    expect(parseDebugRequest({ breakpoints: [] }, GRAPH)).toBeNull()
    expect(parseDebugRequest({ breakpoints: ['ghost'] }, GRAPH)).toBeNull()
    expect(parseDebugRequest(null, GRAPH)).toBeNull()
    expect(parseDebugRequest({ stepFromStart: false }, GRAPH)).toBeNull()
  })

  it('accepts step-from-start with no breakpoints', () => {
    expect(parseDebugRequest({ stepFromStart: true }, GRAPH)).toEqual({
      breakpoints: [],
      stepFromStart: true,
    })
  })

  it('caps and de-duplicates', () => {
    const graph = { nodes: Array.from({ length: 80 }, (_, i) => node(`n${i}`, 'output-log')), edges: [] }
    const parsed = parseDebugRequest(
      { breakpoints: [...Array.from({ length: 80 }, (_, i) => `n${i}`), 'n0', 'n0'] },
      graph
    )
    expect(parsed.breakpoints).toHaveLength(50)
  })
})

describe('pausing a run', () => {
  it('stops before the runner fires, with the resolved config visible', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: { orderId: 'ord-42' } })

    const paused = await waitForBreak(executionId)
    // The side effect has *not* happened…
    expect(calls()).toHaveLength(0)
    // …and the template is already resolved, which is the only moment both
    // facts exist at once.
    expect(JSON.parse(paused.config_json).url).toBe('https://api.example.com/ord-42')
    expect(JSON.parse(paused.input_json).orderId).toBe('ord-42')

    resumeBreak(paused.id, { executionId, action: 'continue' })
    await run
    expect(calls()).toHaveLength(1)
    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId).status).toBe(
      'completed'
    )
  })

  it('holds the rest of the run, not just the branch it stopped on', async () => {
    // A parallel sibling racing ahead while somebody reads the node they
    // stopped at makes the state they are inspecting stale — which is exactly
    // what a debugger exists to prevent.
    const workflowId = makeWorkflow({
      nodes: [
        node('t1', 'trigger-manual'),
        node('a', 'action-http', { url: 'https://api.example.com/a' }, 'A'),
        node('b', 'output-log', { message: 'b' }, 'B'),
      ],
      edges: [edge('t1', 'a'), edge('t1', 'b')],
    })
    const executionId = makeRun(workflowId, { breakpoints: ['a'] })
    const run = runExecution(executionId, { payload: {} })

    const paused = await waitForBreak(executionId)
    await new Promise((r) => setTimeout(r, 60))
    expect(stepFor(executionId, 'b').status).toBe('pending')

    resumeBreak(paused.id, { executionId, action: 'continue' })
    await run
    expect(stepFor(executionId, 'b').status).toBe('succeeded')
  })

  it('steps to the very next node', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: {} })

    const first = await waitForBreak(executionId)
    expect(first.node_id).toBe('h1')
    resumeBreak(first.id, { executionId, action: 'step' })

    const second = await waitForBreak(executionId, 1)
    expect(second.node_id).toBe('o1')
    resumeBreak(second.id, { executionId, action: 'continue' })
    await run
    expect(listBreaks(executionId)).toHaveLength(2)
  })

  it('breaks at every node under step-from-start', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { stepFromStart: true })
    const run = runExecution(executionId, { payload: {} })

    for (let seen = 0; seen < 3; seen++) {
      const paused = await waitForBreak(executionId, seen)
      resumeBreak(paused.id, { executionId, action: 'step' })
    }
    await run
    expect(listBreaks(executionId).map((b) => b.nodeId)).toEqual(['t1', 'h1', 'o1'])
  })

  it('aborts the run from the break', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: {} })

    const paused = await waitForBreak(executionId)
    resumeBreak(paused.id, { executionId, action: 'abort' })
    await run

    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId).status).toBe(
      'cancelled'
    )
    // The HTTP node still fired — cancellation is inter-node everywhere else in
    // the engine, and a break that tore a node down mid-call would be the one
    // place that isn't.
    expect(calls()).toHaveLength(1)
    expect(stepFor(executionId, 'o1').status).toBe('skipped')
  })
})

describe('overrides', () => {
  it('changes what the node runs with, and records that it did', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: { orderId: 'ord-1' } })

    const paused = await waitForBreak(executionId)
    resumeBreak(paused.id, {
      executionId,
      action: 'continue',
      override: { config: { url: 'https://api.example.com/overridden' } },
    })
    await run

    expect(calls()[0].url).toBe('https://api.example.com/overridden')
  })

  it('merges rather than replaces, so one field can change alone', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: {} })

    const paused = await waitForBreak(executionId)
    resumeBreak(paused.id, { executionId, action: 'continue', override: { config: { method: 'POST' } } })
    await run

    expect(calls()[0].method).toBe('POST')
    expect(calls()[0].url).toContain('api.example.com')
  })

  it('rewrites the recorded input when the input is overridden', async () => {
    // A run whose history shows the pre-override value would be a debugger that
    // lies about what it did.
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: { orderId: 'ord-1' } })

    const paused = await waitForBreak(executionId)
    resumeBreak(paused.id, { executionId, action: 'continue', override: { input: { orderId: 'ord-999' } } })
    await run

    expect(JSON.parse(stepFor(executionId, 'h1').input_json).orderId).toBe('ord-999')
  })

  it('refuses a patch that is not a shallow object of values', () => {
    expect(sanitizeOverride(null)).toBeNull()
    expect(sanitizeOverride({ config: 'nope' })).toBeNull()
    expect(sanitizeOverride({ config: ['a'] })).toBeNull()
    expect(sanitizeOverride({ config: {} })).toBeNull()
    expect(sanitizeOverride({ config: JSON.parse('{"__proto__":{"x":1},"url":"ok"}') })).toEqual({
      config: { url: 'ok' },
    })
  })
})

describe('resuming', () => {
  it('resolves two racing resumes to exactly one winner', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: {} })

    const paused = await waitForBreak(executionId)
    expect(resumeBreak(paused.id, { executionId, action: 'continue' })).toEqual({ ok: true })
    const second = resumeBreak(paused.id, { executionId, action: 'abort' })
    expect(second).toMatchObject({ ok: false, alreadySettled: true, status: 'resumed' })
    await run
  })

  it('refuses a break belonging to another run', async () => {
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    const run = runExecution(executionId, { payload: {} })
    const paused = await waitForBreak(executionId)

    // Scoped in the WHERE clause, so it is never resumed and *then* rejected.
    expect(resumeBreak(paused.id, { executionId: uuidv4(), action: 'continue' })).toMatchObject({
      notFound: true,
    })
    expect(
      db.prepare('SELECT status FROM execution_breaks WHERE id = ?').get(paused.id).status
    ).toBe('paused')

    resumeBreak(paused.id, { executionId, action: 'continue' })
    await run
  })

  it('refuses an unknown action', () => {
    expect(resumeBreak('anything', { executionId: 'x', action: 'explode' })).toMatchObject({
      error: 'Unknown debug action',
    })
  })
})

describe('the timeout', () => {
  it('fails the run rather than quietly letting the node go', async () => {
    // Continuing would mean a node ran with nobody watching, in a session whose
    // entire purpose was that somebody was watching.
    process.env.DEBUG_BREAK_TIMEOUT_MS = '60'
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] })
    await runExecution(executionId, { payload: {} })
    delete process.env.DEBUG_BREAK_TIMEOUT_MS

    const execution = db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId)
    expect(execution.status).toBe('failed')
    expect(stepFor(executionId, 'h1').error).toContain('[debugger]')
    expect(calls()).toHaveLength(0)
    expect(listBreaks(executionId)[0].status).toBe('expired')
  })
})

describe('breakpoints belong to a run, not a workflow', () => {
  it('never pauses a run that was not started as a debug session', async () => {
    // The whole safety story. There is no workflow-level place to leave a
    // breakpoint, so a schedule tick has nowhere to read one from.
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, null, 'schedule')
    await runExecution(executionId, { payload: {} })

    expect(listBreaks(executionId)).toEqual([])
    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId).status).toBe(
      'completed'
    )
  })

  it('never pauses a dry run', async () => {
    // A test run's whole point is that it completes without a person; pausing
    // one would make the test scenarios hang instead of report.
    const workflowId = makeWorkflow()
    const executionId = makeRun(workflowId, { breakpoints: ['h1'] }, 'dry-run')
    await runExecution(executionId, { payload: {}, dryRun: true })

    expect(listBreaks(executionId)).toEqual([])
    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(executionId).status).toBe(
      'completed'
    )
  })
})
