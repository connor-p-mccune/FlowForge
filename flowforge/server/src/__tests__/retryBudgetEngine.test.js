// The retry budget as the engine actually applies it.
//
// retryBudget.test.js proves the arithmetic; this proves the wiring — that a
// node against a host over its budget stops after one attempt instead of three,
// that the run still fails with the *real* error, and that a node with nothing
// to cascade into is unaffected.
//
// The observable is a local HTTP server counting how many times it was hit,
// because "did it retry" is not a thing the step row records.

const http = require('http')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'
process.env.ENABLE_RETRY_BUDGET = 'true'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const retryBudget = require('../services/retryBudget')

let server
let port
let hits

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end('{"error":"overloaded"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
  delete process.env.ENABLE_RETRY_BUDGET
  delete process.env.RETRY_BUDGET_MIN
  delete process.env.RETRY_BUDGET_RATIO
})

beforeEach(() => {
  hits = 0
  retryBudget.reset()
  process.env.RETRY_BUDGET_MIN = '10'
  process.env.RETRY_BUDGET_RATIO = '0.1'
})

// Spend the host's allowance on somebody else's behalf: 20 requests gives a
// ratio budget of 2, the floor gives 10, and 12 retries clears both.
function exhaust(url) {
  for (let i = 0; i < 20; i++) retryBudget.recordRequest(url)
  for (let i = 0; i < 12; i++) retryBudget.recordRetry(url)
}

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

function seedRun(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'T', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)
  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return execId
}

const httpGraph = () => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('call', 'action-http', { method: 'GET', url: `http://127.0.0.1:${port}/`, headers: '{}' }),
  ],
  edges: [edge('t1', 'call')],
})

const stepFor = (execId, nodeId) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?').get(execId, nodeId)

describe('the engine under a retry budget', () => {
  it('retries normally while the host is within budget', async () => {
    const execId = seedRun(httpGraph())
    await runExecution(execId, { publish: () => {} })

    // Three attempts: the default EXEC_MAX_ATTEMPTS.
    expect(hits).toBe(3)
    expect(stepFor(execId, 'call').status).toBe('failed')
  })

  it('stops after one attempt when the host is over budget', async () => {
    exhaust(`http://127.0.0.1:${port}/`)

    const execId = seedRun(httpGraph())
    await runExecution(execId, { publish: () => {} })

    expect(hits).toBe(1)
    expect(stepFor(execId, 'call').status).toBe('failed')
  })

  it('budgets by host, so a spent API cannot stop retries to a healthy one', async () => {
    exhaust('https://someone-elses-api.example.com/')

    const execId = seedRun(httpGraph())
    await runExecution(execId, { publish: () => {} })

    expect(hits).toBe(3)
  })

  it('fails with the real error, with the suppression appended rather than substituted', async () => {
    exhaust(`http://127.0.0.1:${port}/`)

    const execId = seedRun(httpGraph())
    await runExecution(execId, { publish: () => {} })

    const error = stepFor(execId, 'call').error
    // The cause first — "the API returned 503" is what broke.
    expect(error).toMatch(/503/)
    // Then why it stopped there.
    expect(error).toMatch(/retries suppressed/)
    expect(error).toMatch(/over its retry budget/)
  })

  it('counts its own attempts, so one run can exhaust the budget for the next', async () => {
    process.env.RETRY_BUDGET_MIN = '2'
    const first = seedRun(httpGraph())
    await runExecution(first, { publish: () => {} })
    // Budget 2: attempt, retry, retry — three hits, two retries recorded.
    expect(hits).toBe(3)

    hits = 0
    const second = seedRun(httpGraph())
    await runExecution(second, { publish: () => {} })
    // The allowance is spent, so the second run gets one attempt.
    expect(hits).toBe(1)
  })

  it('leaves a node with no host to cascade into alone', async () => {
    // A Filter node's retry costs nobody anything but a millisecond of CPU, so
    // the budget never applies to it — not even a wholly exhausted one.
    for (let i = 0; i < 100; i++) retryBudget.recordRetry('https://anything.example.com/')

    const execId = seedRun({
      nodes: [
        node('t1', 'trigger-manual'),
        node('bad', 'filter', { source: '[1,2,3]', predicate: '1 +' }),
      ],
      edges: [edge('t1', 'bad')],
    })
    await runExecution(execId, { publish: () => {} })
    expect(stepFor(execId, 'bad').status).toBe('failed')
    expect(stepFor(execId, 'bad').error).not.toMatch(/retry budget/)
  })

  it('does not budget a dry run, which sends nothing', async () => {
    exhaust(`http://127.0.0.1:${port}/`)

    const execId = seedRun(httpGraph())
    await runExecution(execId, { publish: () => {}, dryRun: true })

    expect(hits).toBe(0)
    expect(stepFor(execId, 'call').status).toBe('succeeded')
  })
})
