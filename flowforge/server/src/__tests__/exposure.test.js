// Which workflow should I look at first?
//
// The ranking is a product of two measured things — what a run can do to the
// outside world, and how often it runs — and most of what is worth testing here
// is what the report refuses to claim: that a gate it has not evaluated is
// holding, that a subroutine is dangerous because its caller is, or that four
// scenarios make a workflow safe.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { exposureReport } = require('../services/exposure')

const DAY_MS = 86400000
let userId
let wsId

beforeAll(() => {
  userId = uuidv4()
  wsId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
})

beforeEach(() => {
  db.prepare('DELETE FROM executions').run()
  db.prepare('DELETE FROM workflow_tests').run()
  db.prepare('DELETE FROM workflow_assertions').run()
  db.prepare('DELETE FROM workflows WHERE workspace_id = ?').run(wsId)
})

function addWorkflow(name, graph, extra = {}) {
  const id = extra.id || uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, guarantees_json,
                            drift_monitoring, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'deployed', ?, ?, ?)`
  ).run(
    id,
    wsId,
    name,
    typeof graph === 'string' ? graph : JSON.stringify(graph),
    extra.guarantees ? JSON.stringify(extra.guarantees) : null,
    extra.drift ? 1 : 0,
    userId,
    now,
    now
  )
  return id
}

// `agoDays` is how long ago the *first* run was; the rest are spread forward
// from it, because the rate's denominator is the observed span rather than the
// whole window. `parentId` marks the runs as made on somebody else's behalf,
// which is how a sub-workflow call records itself.
function addRuns(workflowId, count, { agoDays = 10, parentId = null } = {}) {
  const start = Date.now() - agoDays * DAY_MS
  const stmt = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, parent_execution_id, created_at)
     VALUES (?, ?, 'completed', ?, ?)`
  )
  const ids = []
  for (let i = 0; i < count; i += 1) {
    const at = new Date(start + (i * agoDays * DAY_MS) / Math.max(1, count)).toISOString()
    const id = uuidv4()
    stmt.run(id, workflowId, parentId, at)
    ids.push(id)
  }
  return ids
}

const httpNode = (id, url = 'https://api.acme.com/charge') => ({
  id,
  type: 'action-http',
  data: { label: `Call ${id}`, config: { url, method: 'POST' } },
})

const trigger = { id: 'trigger', type: 'trigger-webhook', data: { label: 'Start', config: {} } }

const straightLine = (nodes) => ({
  nodes: [trigger, ...nodes],
  edges: nodes.map((n, i) => ({
    id: `e${i}`,
    source: i === 0 ? 'trigger' : nodes[i - 1].id,
    target: n.id,
  })),
})

describe('exposure — the unit', () => {
  it('multiplies what a run does by how often it runs', () => {
    // 2 ungated effects, 20 direct runs over an observed 10 days = 4 outward
    // actions a day.
    const id = addWorkflow('Orders', straightLine([httpNode('a'), httpNode('b')]))
    addRuns(id, 20, { agoDays: 10 })

    const report = exposureReport(wsId)
    const row = report.workflows.find((r) => r.workflowId === id)
    expect(row.runs.perDay).toBe(2)
    expect(row.effects.unconditional).toBe(2)
    expect(row.exposure.floor).toBe(4)
    expect(row.exposure.ceiling).toBe(4)
  })

  it('ranks a rare dangerous workflow below a frequent one that does as much', () => {
    // Consequence alone is not the answer; neither is volume.
    const rare = addWorkflow('Yearly reconcile', straightLine([httpNode('a'), httpNode('b')]))
    const busy = addWorkflow('Order webhook', straightLine([httpNode('a')]))
    addRuns(rare, 2, { agoDays: 20 })
    addRuns(busy, 400, { agoDays: 20 })

    const report = exposureReport(wsId)
    expect(report.workflows[0].workflowId).toBe(busy)
  })

  it('scores a workflow that does nothing outward at zero however often it runs', () => {
    const id = addWorkflow('Log only', {
      nodes: [trigger, { id: 'log', type: 'action-log', data: { label: 'Log', config: {} } }],
      edges: [{ id: 'e0', source: 'trigger', target: 'log' }],
    })
    addRuns(id, 5000, { agoDays: 10 })

    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === id)
    expect(row.runs.perDay).toBe(500)
    expect(row.exposure.ceiling).toBe(0)
  })

  it('measures the rate over the span it observed, not the whole window', () => {
    // A workflow deployed four days ago that has run 400 times runs 100 times a
    // day. Dividing by the 30-day window would report 13 and rank it nowhere.
    const id = addWorkflow('New', straightLine([httpNode('a')]))
    addRuns(id, 400, { agoDays: 4 })

    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === id)
    expect(row.runs.observedDays).toBeCloseTo(4, 1)
    expect(row.runs.perDay).toBeGreaterThan(90)
  })
})

describe('exposure — the interval', () => {
  const gated = {
    nodes: [
      trigger,
      {
        id: 'check',
        type: 'condition',
        data: {
          label: 'Approve?',
          config: { operator: 'expression', expression: 'total > 100' },
        },
      },
      httpNode('charge'),
      httpNode('audit'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'check' },
      { id: 'e1', source: 'check', sourceHandle: 'true', target: 'charge' },
      { id: 'e2', source: 'trigger', target: 'audit' },
    ],
  }

  it('separates what a run definitely does from what it might', () => {
    const id = addWorkflow('Payments', gated)
    addRuns(id, 10, { agoDays: 10 })

    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === id)
    expect(row.effects.total).toBe(2)
    expect(row.effects.unconditional).toBe(1)
    expect(row.exposure.floor).toBe(1)
    expect(row.exposure.ceiling).toBe(2)
  })

  it('ranks by the worst case, because an untested gate is not evidence', () => {
    // Four gated effects outrank one ungated one at the same rate: the queue
    // exists to find workflows nobody has checked, and a gate nobody has
    // checked is exactly what is in question.
    const many = addWorkflow('Fulfilment', {
      nodes: [
        trigger,
        {
          id: 'check',
          type: 'condition',
          data: { label: 'Ship?', config: { operator: 'expression', expression: 'ok' } },
        },
        httpNode('a'),
        httpNode('b'),
        httpNode('c'),
        httpNode('d'),
      ],
      edges: [
        { id: 'e0', source: 'trigger', target: 'check' },
        ...['a', 'b', 'c', 'd'].map((n, i) => ({
          id: `e${i + 1}`,
          source: 'check',
          sourceHandle: 'true',
          target: n,
        })),
      ],
    })
    const one = addWorkflow('Notify', straightLine([httpNode('a')]))
    addRuns(many, 10, { agoDays: 10 })
    addRuns(one, 10, { agoDays: 10 })

    const report = exposureReport(wsId)
    expect(report.workflows[0].workflowId).toBe(many)
    expect(report.workflows[0].exposure.floor).toBe(0)
  })

  it('puts the workflow whose worst case is also its ordinary case first', () => {
    const certain = addWorkflow('Always charges', straightLine([httpNode('a'), httpNode('b')]))
    const maybe = addWorkflow('Maybe charges', gated)
    addRuns(certain, 10, { agoDays: 10 })
    addRuns(maybe, 10, { agoDays: 10 })

    // Same ceiling of 2/day; the one with nothing gating it is the one to read.
    const report = exposureReport(wsId)
    expect(report.workflows[0].exposure.ceiling).toBe(report.workflows[1].exposure.ceiling)
    expect(report.workflows[0].workflowId).toBe(certain)
  })
})

describe('exposure — across the sub-workflow boundary', () => {
  function twoWorkflows() {
    const calleeId = uuidv4()
    addWorkflow('Fulfilment', straightLine([httpNode('charge')]), { id: calleeId })
    const callerId = addWorkflow('Orders', {
      nodes: [
        trigger,
        {
          id: 'call',
          type: 'sub-workflow',
          data: { label: 'Fulfil order', config: { workflowId: calleeId } },
        },
      ],
      edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
    })
    return { callerId, calleeId }
  }

  it('counts an effect that happens inside a workflow this one calls', () => {
    const { callerId } = twoWorkflows()
    addRuns(callerId, 10, { agoDays: 10 })

    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === callerId)
    expect(row.effects.total).toBe(1)
    expect(row.effects.inherited).toBe(1)
    expect(row.exposure.ceiling).toBe(1)
  })

  it('does not count a called run twice', () => {
    // The callee's runs exist because the caller made them; its consequence is
    // already in the caller's row, and counting it again would double the
    // workspace total and rank the subroutine above the decision to call it.
    const { callerId, calleeId } = twoWorkflows()
    const parents = addRuns(callerId, 10, { agoDays: 10 })
    addRuns(calleeId, 10, { agoDays: 10, parentId: parents[0] })

    const report = exposureReport(wsId)
    const callee = report.workflows.find((r) => r.workflowId === calleeId)
    expect(callee.runs.called).toBe(10)
    expect(callee.runs.direct).toBe(0)
    expect(callee.exposure.ceiling).toBe(0)
    expect(report.summary.outwardPerDay.ceiling).toBe(1)
  })

  it('says whose consequence a called-only workflow was counted as', () => {
    // A bare zero would read as "harmless" when it means "attributed
    // elsewhere".
    const { calleeId } = twoWorkflows()
    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === calleeId)
    expect(row.attributed).toBe(true)
    expect(row.calledBy).toEqual(['Orders'])
  })

  it('still scores a callee that is also triggered directly', () => {
    const { calleeId } = twoWorkflows()
    addRuns(calleeId, 10, { agoDays: 10 })

    const row = exposureReport(wsId).workflows.find((r) => r.workflowId === calleeId)
    expect(row.attributed).toBe(false)
    expect(row.exposure.ceiling).toBe(1)
  })

  it('reports how much of a workspace happens off the canvas', () => {
    const { callerId } = twoWorkflows()
    addRuns(callerId, 10, { agoDays: 10 })
    expect(exposureReport(wsId).summary.offCanvas).toBe(1)
  })
})

describe('exposure — assurance', () => {
  let id

  beforeEach(() => {
    id = addWorkflow('Payments', straightLine([httpNode('a')]))
    addRuns(id, 10, { agoDays: 10 })
  })

  const rowFor = () => exposureReport(wsId).workflows.find((r) => r.workflowId === id)

  it('queues a workflow with consequence and nothing checking it', () => {
    const report = exposureReport(wsId)
    expect(report.queue).toEqual([id])
    expect(report.summary.unchecked).toBe(1)
    expect(report.summary.uncheckedShare).toBe(1)
  })

  it('counts each kind of check separately and never sums them', () => {
    db.prepare(
      `INSERT INTO workflow_tests (id, workflow_id, name, assertions, created_by, created_at, updated_at)
       VALUES (?, ?, 'happy path', '[]', ?, datetime('now'), datetime('now'))`
    ).run(uuidv4(), id, userId)

    const row = rowFor()
    expect(row.assurance).toMatchObject({ scenarios: 1, guarantees: 0, assertions: 0, drift: false })
    expect(row.assurance.checked).toBe(true)
  })

  it.each([
    [
      'a scenario',
      () =>
        db
          .prepare(
            `INSERT INTO workflow_tests (id, workflow_id, name, assertions, created_by, created_at, updated_at)
             VALUES (?, ?, 't', '[]', ?, datetime('now'), datetime('now'))`
          )
          .run(uuidv4(), id, userId),
    ],
    [
      'a run assertion',
      () =>
        db
          .prepare(
            `INSERT INTO workflow_assertions (id, workflow_id, name, predicate, created_at)
             VALUES (?, ?, 'no refunds', 'true', datetime('now'))`
          )
          .run(uuidv4(), id),
    ],
    [
      'a declared guarantee',
      () =>
        db
          .prepare("UPDATE workflows SET guarantees_json = ? WHERE id = ?")
          .run(JSON.stringify([{ kind: 'always-before', node: 'a', other: 'b' }]), id),
    ],
    ['drift monitoring', () => db.prepare('UPDATE workflows SET drift_monitoring = 1 WHERE id = ?').run(id)],
  ])('takes %s off the queue', (_label, setup) => {
    setup()
    const report = exposureReport(wsId)
    expect(report.queue).toEqual([])
    expect(report.summary.uncheckedShare).toBe(0)
  })

  it('does not let a check change where a workflow ranks', () => {
    // Assurance is reported beside the exposure, never folded into it: four
    // scenarios do not make a workflow four units less consequential.
    const before = rowFor().exposure
    db.prepare('UPDATE workflows SET drift_monitoring = 1 WHERE id = ?').run(id)
    expect(rowFor().exposure).toEqual(before)
  })

  it('leaves a called-only workflow out of the queue', () => {
    // Acting on it means acting on its caller, which is in the list already.
    const calleeId = uuidv4()
    addWorkflow('Utility', straightLine([httpNode('x')]), { id: calleeId })
    const callerId = addWorkflow('Caller', {
      nodes: [
        trigger,
        { id: 'call', type: 'sub-workflow', data: { label: 'Go', config: { workflowId: calleeId } } },
      ],
      edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
    })
    const parents = addRuns(callerId, 10, { agoDays: 10 })
    addRuns(calleeId, 10, { agoDays: 10, parentId: parents[0] })

    expect(exposureReport(wsId).queue).not.toContain(calleeId)
  })
})

describe('exposure — what it refuses', () => {
  it('reports an unreadable graph as unreadable rather than as harmless', () => {
    addWorkflow('Broken', '{not json')
    const report = exposureReport(wsId)
    expect(report.summary.unreadable).toBe(1)
    expect(report.workflows).toHaveLength(0)
  })

  it('returns an empty report for a workspace with nothing in it', () => {
    const report = exposureReport(wsId)
    expect(report.summary.workflows).toBe(0)
    expect(report.summary.uncheckedShare).toBe(0)
    expect(report.queue).toEqual([])
  })

  it('ignores runs older than the window', () => {
    const id = addWorkflow('Old', straightLine([httpNode('a')]))
    addRuns(id, 100, { agoDays: 90 })

    const row = exposureReport(wsId, { days: 30 }).workflows.find((r) => r.workflowId === id)
    expect(row.runs.direct).toBeLessThan(100)
  })

  it('orders two identical workflows by name so the list does not shuffle', () => {
    const b = addWorkflow('B', straightLine([httpNode('a')]))
    const a = addWorkflow('A', straightLine([httpNode('a')]))
    addRuns(a, 10, { agoDays: 10 })
    addRuns(b, 10, { agoDays: 10 })

    expect(exposureReport(wsId).workflows.map((r) => r.name)).toEqual(['A', 'B'])
  })

  it('keeps each workspace to itself', () => {
    const otherWs = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(otherWs, 'Other', userId, now, now)
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, created_at, updated_at)
       VALUES (?, ?, 'Theirs', ?, 'deployed', ?, ?, ?)`
    ).run(uuidv4(), otherWs, JSON.stringify(straightLine([httpNode('a')])), userId, now, now)

    expect(exposureReport(wsId).summary.workflows).toBe(0)
  })
})
