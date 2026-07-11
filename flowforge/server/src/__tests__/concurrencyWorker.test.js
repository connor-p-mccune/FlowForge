// The worker's pickup gate: a run whose workflow is at its concurrency cap is
// re-parked (queue.add with a delay) instead of executed, dry runs are exempt,
// and the slot frees once the running execution settles.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.CONCURRENCY_RETRY_MS = '100'

// Capture the processor the worker registers, and every re-park it issues.
let processor = null
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({
  getExecutionQueue: () => ({
    process: (_concurrency, fn) => {
      processor = fn
    },
    add: mockAdd,
  }),
}))
jest.mock('../config/redis', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(1),
}))

// The engine is not under test here — hand back controllable promises so the
// test decides exactly when a run is "in flight" vs settled.
const runResolvers = {}
jest.mock('../services/executionEngine', () => ({
  runExecution: jest.fn(
    (executionId) =>
      new Promise((resolve) => {
        runResolvers[executionId] = resolve
      })
  ),
}))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const { startWorker } = require('../workers/executionWorker')
const { _activeRuns } = require('../services/concurrencyGate')

function seedWorkflow({ limit = null } = {}) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, max_concurrent_runs, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', '{"nodes":[],"edges":[]}', limit, userId, now, now)
  return wfId
}

function seedExecution(workflowId) {
  const id = uuidv4()
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).run(id, workflowId, new Date().toISOString())
  return id
}

beforeAll(() => {
  startWorker()
})

beforeEach(() => {
  mockAdd.mockClear()
  runExecution.mockClear()
  _activeRuns.clear()
})

describe('worker concurrency gate', () => {
  it('defers a run at the cap and executes it once the slot frees', async () => {
    const wfId = seedWorkflow({ limit: 1 })
    const exec1 = seedExecution(wfId)
    const exec2 = seedExecution(wfId)

    // First job takes the workflow's only slot and stays in flight.
    const job1 = processor({ data: { executionId: exec1, workflowId: wfId } })
    expect(runExecution).toHaveBeenCalledTimes(1)

    // Second job finds the cap and is re-parked with a delay — not executed.
    await processor({ data: { executionId: exec2, workflowId: wfId } })
    expect(runExecution).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      { executionId: exec2, workflowId: wfId },
      { delay: 100 }
    )

    // The first run settles; the re-parked clone now goes through.
    runResolvers[exec1]({})
    await job1
    const job2 = processor({ data: { executionId: exec2, workflowId: wfId } })
    expect(runExecution).toHaveBeenCalledTimes(2)
    runResolvers[exec2]({})
    await job2
  })

  it('exempts dry runs from the cap', async () => {
    const wfId = seedWorkflow({ limit: 1 })
    const exec1 = seedExecution(wfId)
    const exec2 = seedExecution(wfId)

    const job1 = processor({ data: { executionId: exec1, workflowId: wfId } })
    const job2 = processor({ data: { executionId: exec2, workflowId: wfId, dryRun: true } })
    // Both are in flight: the dry run neither waited for nor consumed a slot.
    expect(runExecution).toHaveBeenCalledTimes(2)
    expect(mockAdd).not.toHaveBeenCalled()

    runResolvers[exec1]({})
    runResolvers[exec2]({})
    await Promise.all([job1, job2])
  })

  it('runs unlimited workflows concurrently and frees slots on failure', async () => {
    const wfId = seedWorkflow() // no limit
    const execs = [seedExecution(wfId), seedExecution(wfId), seedExecution(wfId)]
    const jobs = execs.map((id) => processor({ data: { executionId: id, workflowId: wfId } }))
    expect(runExecution).toHaveBeenCalledTimes(3)
    for (const id of execs) runResolvers[id]({})
    await Promise.all(jobs)

    // A crash inside the engine still releases the slot (finally path).
    const limited = seedWorkflow({ limit: 1 })
    const failing = seedExecution(limited)
    runExecution.mockRejectedValueOnce(new Error('setup crash'))
    await expect(
      processor({ data: { executionId: failing, workflowId: limited } })
    ).rejects.toThrow('setup crash')

    const next = seedExecution(limited)
    const job = processor({ data: { executionId: next, workflowId: limited } })
    // The slot was released by the failed run, so this one executes.
    expect(runExecution).toHaveBeenCalledTimes(5)
    runResolvers[next]({})
    await job
  })
})
