// Fair queueing as the worker actually applies it.
//
// fairShare.test.js proves the rule; this proves the wiring — that a workflow
// far ahead of a waiting one is re-parked instead of executed, that the re-park
// carries its lane and its deferral count, and that the quiet workflow's run
// goes straight through the queue the bulk one was monopolising.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.CONCURRENCY_RETRY_MS = '100'
process.env.FAIR_SHARE_BURST = '2'

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

// Runs settle immediately: this test is about admission, not execution.
jest.mock('../services/executionEngine', () => ({
  runExecution: jest.fn().mockResolvedValue({}),
}))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const { startWorker } = require('../workers/executionWorker')
const fairShare = require('../services/fairShare')

function seedWorkflow() {
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
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', '{"nodes":[],"edges":[]}', userId, now, now)
  return wfId
}

function seedExecution(workflowId) {
  const id = uuidv4()
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).run(id, workflowId, new Date().toISOString())
  return id
}

// Push `n` jobs of one workflow through the processor.
const drain = async (workflowId, n, opts) => {
  for (let i = 0; i < n; i++) {
    await processor({ data: { executionId: seedExecution(workflowId), workflowId }, ...opts })
  }
}

let bulk
let quiet

beforeAll(() => {
  startWorker()
})

beforeEach(() => {
  mockAdd.mockClear()
  runExecution.mockClear()
  fairShare.reset()
  bulk = seedWorkflow()
  quiet = seedWorkflow()
})

afterAll(() => {
  delete process.env.FAIR_SHARE_BURST
})

describe('the worker under fair queueing', () => {
  it('lets one workflow have the whole queue when nobody else wants it', async () => {
    // The bulk case is normal until it is contended. A fairness control that
    // taxed an idle system would be a latency regression sold as a feature.
    await drain(bulk, 20)
    expect(runExecution).toHaveBeenCalledTimes(20)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('holds back the workflow that is far ahead of one that is waiting', async () => {
    await drain(bulk, 20)
    runExecution.mockClear()

    // The quiet workflow's job arrives and is itself admitted — it is behind,
    // not ahead. Getting deferred is what makes it a contender, so simulate
    // the queue state where it has been.
    fairShare.recordDeferred(quiet, 'normal')

    await drain(bulk, 1)
    expect(runExecution).not.toHaveBeenCalled()
    expect(mockAdd).toHaveBeenCalledTimes(1)
  })

  it('lets the waiting workflow straight through the queue it was behind', async () => {
    await drain(bulk, 20)
    fairShare.recordDeferred(quiet, 'normal')
    runExecution.mockClear()
    mockAdd.mockClear()

    await drain(quiet, 1)
    expect(runExecution).toHaveBeenCalledTimes(1)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('re-parks with the lane and a bumped deferral count', async () => {
    // Contended *within* the high lane — Bull priority 1 — since fairness never
    // reaches across lanes and the same backlog in `normal` would not hold this
    // job at all.
    await drain(bulk, 20, { opts: { priority: 1 } })
    fairShare.recordDeferred(quiet, 'high')
    mockAdd.mockClear()

    const executionId = seedExecution(bulk)
    await processor({
      data: { executionId, workflowId: bulk, fairDeferrals: 3 },
      opts: { priority: 1 },
    })

    expect(mockAdd).toHaveBeenCalledWith(
      { executionId, workflowId: bulk, fairDeferrals: 4 },
      // The lane rides along: a deferral must never silently demote a run
      // somebody explicitly prioritised.
      { delay: 100, priority: 1 }
    )
  })

  it('never lets fairness in one lane hold up another', async () => {
    // Bull priority 1 is the high lane; the bulk workflow's backlog is in the
    // normal one. Priority orders runs between lanes, fairness within one.
    await drain(bulk, 20)
    fairShare.recordDeferred(quiet, 'normal')
    runExecution.mockClear()

    await drain(bulk, 1, { opts: { priority: 1 } })
    expect(runExecution).toHaveBeenCalledTimes(1)
  })

  it('admits a job that has been deferred too many times', async () => {
    await drain(bulk, 50)
    fairShare.recordDeferred(quiet, 'normal')
    runExecution.mockClear()
    mockAdd.mockClear()

    await processor({
      data: { executionId: seedExecution(bulk), workflowId: bulk, fairDeferrals: 20 },
    })
    // A queue that is perfectly fair and never runs your job is worse than one
    // that is unfair.
    expect(runExecution).toHaveBeenCalledTimes(1)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('exempts dry runs, which are interactive', async () => {
    await drain(bulk, 50)
    fairShare.recordDeferred(quiet, 'normal')
    runExecution.mockClear()

    await processor({ data: { executionId: seedExecution(bulk), workflowId: bulk, dryRun: true } })
    expect(runExecution).toHaveBeenCalledTimes(1)
  })

  it('is inert when switched off', async () => {
    process.env.DISABLE_FAIR_SHARE = 'true'
    try {
      await drain(bulk, 50)
      fairShare.recordDeferred(quiet, 'normal')
      runExecution.mockClear()
      await drain(bulk, 1)
      expect(runExecution).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.DISABLE_FAIR_SHARE
    }
  })
})
