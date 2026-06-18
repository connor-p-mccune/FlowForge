process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')

// Capture enqueues + lock calls instead of touching Bull / Redis.
const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const mockRedis = { set: jest.fn(), del: jest.fn().mockResolvedValue(1) }
jest.mock('../config/redis', () => mockRedis)

const db = require('../config/database')
const scheduler = require('../services/scheduler')

// Insert a workflow (with the user + workspace its FKs require) directly, so the
// scheduler unit tests don't have to drive the whole HTTP/auth stack.
function seedWorkflow({ status = 'deployed', graph } = {}) {
  const userId = uuidv4()
  db.prepare('INSERT INTO users (id, email, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(userId, `${userId}@example.com`, 'hash', 'Sched')
  const wsId = uuidv4()
  db.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').run(wsId, 'WS', userId)
  const wfId = uuidv4()
  const defaultGraph = {
    nodes: [
      { id: 't1', type: 'trigger-schedule', position: { x: 0, y: 0 }, data: { config: { cron: '* * * * *' } } },
    ],
    edges: [],
  }
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'Sched WF', JSON.stringify(graph || defaultGraph), status, userId)
  return wfId
}

afterEach(() => {
  // Stop any cron tasks a test registered (otherwise their timers keep Jest alive)
  for (const id of [...scheduler._activeTasks.keys()]) scheduler.unregisterSchedule(id)
  db.exec('DELETE FROM workflows') // cascades executions; isolates restore tests
  jest.clearAllMocks()
})

describe('validateCron', () => {
  it('accepts valid expressions (and trims surrounding whitespace)', () => {
    expect(scheduler.validateCron('* * * * *')).toBe(true)
    expect(scheduler.validateCron('0 9 * * 1')).toBe(true)
    expect(scheduler.validateCron('  0 9 1 * *  ')).toBe(true)
  })

  it('rejects empty, malformed, and non-string input', () => {
    expect(scheduler.validateCron('')).toBe(false)
    expect(scheduler.validateCron('   ')).toBe(false)
    expect(scheduler.validateCron('not a cron')).toBe(false)
    expect(scheduler.validateCron('99 99 99 99 99')).toBe(false)
    expect(scheduler.validateCron(null)).toBe(false)
    expect(scheduler.validateCron(undefined)).toBe(false)
  })
})

describe('runScheduledExecution', () => {
  it('takes the lock, enqueues a pending execution, then releases the lock', async () => {
    mockRedis.set.mockResolvedValue('OK')
    const wfId = seedWorkflow()

    await scheduler.runScheduledExecution(wfId)

    expect(mockRedis.set).toHaveBeenCalledWith(
      `lock:schedule:${wfId}`, '1', 'EX', expect.any(Number), 'NX'
    )
    expect(mockAdd).toHaveBeenCalledTimes(1)
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: wfId, payload: {} })
    )

    const execs = db.prepare('SELECT * FROM executions WHERE workflow_id = ?').all(wfId)
    expect(execs).toHaveLength(1)
    expect(execs[0].status).toBe('pending')
    expect(execs[0].triggered_by).toBeNull()

    expect(mockRedis.del).toHaveBeenCalledWith(`lock:schedule:${wfId}`)
  })

  it('no-ops when another instance already holds the lock', async () => {
    mockRedis.set.mockResolvedValue(null)
    const wfId = seedWorkflow()

    await scheduler.runScheduledExecution(wfId)

    expect(mockAdd).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions WHERE workflow_id = ?').get(wfId).c).toBe(0)
    expect(mockRedis.del).not.toHaveBeenCalled() // never acquired it, so never release it
  })

  it('does not enqueue a workflow that is no longer deployed', async () => {
    mockRedis.set.mockResolvedValue('OK')
    const wfId = seedWorkflow({ status: 'archived' })

    await scheduler.runScheduledExecution(wfId)

    expect(mockAdd).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS c FROM executions WHERE workflow_id = ?').get(wfId).c).toBe(0)
    expect(mockRedis.del).toHaveBeenCalledWith(`lock:schedule:${wfId}`) // acquired then released
  })

  it('does not enqueue a workflow with an empty graph', async () => {
    mockRedis.set.mockResolvedValue('OK')
    const wfId = seedWorkflow({ graph: { nodes: [], edges: [] } })

    await scheduler.runScheduledExecution(wfId)

    expect(mockAdd).not.toHaveBeenCalled()
  })
})

describe('registerSchedule / unregisterSchedule', () => {
  it('registers and tracks a task, then stops it on unregister', () => {
    const wfId = seedWorkflow()
    expect(scheduler._activeTasks.has(wfId)).toBe(false)

    scheduler.registerSchedule(wfId, '* * * * *')
    expect(scheduler._activeTasks.has(wfId)).toBe(true)

    expect(scheduler.unregisterSchedule(wfId)).toBe(true)
    expect(scheduler._activeTasks.has(wfId)).toBe(false)
    expect(scheduler.unregisterSchedule(wfId)).toBe(false) // nothing left to stop
  })

  it('throws on an invalid cron expression', () => {
    expect(() => scheduler.registerSchedule('wf-x', 'nonsense')).toThrow(/Invalid cron/)
    expect(scheduler._activeTasks.has('wf-x')).toBe(false)
  })

  it('replaces the existing task when re-registering the same workflow', () => {
    const wfId = seedWorkflow()
    scheduler.registerSchedule(wfId, '0 * * * *')
    expect(scheduler._activeTasks.get(wfId).cron).toBe('0 * * * *')

    scheduler.registerSchedule(wfId, '0 9 * * *')
    expect(scheduler._activeTasks.get(wfId).cron).toBe('0 9 * * *')
    expect(scheduler._activeTasks.size).toBe(1)
  })
})

describe('restoreSchedules', () => {
  it('registers only deployed workflows that carry a valid schedule node', () => {
    const deployedId = seedWorkflow({ status: 'deployed' })
    seedWorkflow({ status: 'draft' }) // not deployed → skipped
    seedWorkflow({
      status: 'deployed',
      graph: { nodes: [{ id: 'm', type: 'trigger-manual', data: {} }], edges: [] },
    }) // deployed but no schedule node → skipped

    const count = scheduler.restoreSchedules()

    expect(count).toBe(1)
    expect(scheduler._activeTasks.has(deployedId)).toBe(true)
  })
})
