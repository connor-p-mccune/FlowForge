// The contract check against a real workspace: whose workflows does this change
// break?
//
// The scenario every test here is a variation of: a workflow returns something,
// another workflow calls it and reads a field off the result, and somebody
// edits the first one. The callee still lints. The dependency graph still
// resolves. The caller is broken, and nothing in the product said so.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { analyzeContract, callersOf } = require('../services/contractCheck')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

let workspaceId
let userId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

function seed(name, graph, ws = workspaceId) {
  const id = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
     VALUES (?, ?, ?, ?, 'deployed', ?)`
  ).run(id, ws, name, JSON.stringify(graph), userId)
  return id
}

// A workflow whose return node emits the given JSON literal.
const callee = (template) => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('shape', 'transform', { template }),
    node('out', 'output-return', { value: '{{shape}}' }),
  ],
  edges: [edge('t1', 'shape'), edge('shape', 'out')],
})

// A workflow that calls `targetId` and uses one field off the result.
const caller = (targetId, usage, type = 'sub-workflow') => ({
  nodes: [
    node('t1', 'trigger-manual'),
    node('call', type, { workflowId: targetId }, 'Fulfil order'),
    node('ship', 'action-http', { url: usage }, 'Notify carrier'),
  ],
  edges: [edge('t1', 'call'), edge('call', 'ship')],
})

const SHAPE = '{"orderId": "abc", "total": 10}'

describe('analyzeContract', () => {
  it('refuses an unknown workflow', () => {
    expect(analyzeContract(uuidv4())).toEqual({ available: false, reason: 'not-found' })
  })

  it('reports a workflow nobody calls as compatible with itself', () => {
    // The CI shape: asking whether what is deployed honours its own contract
    // compares it with itself, which it trivially does.
    const id = seed('Lonely', callee(SHAPE))
    const report = analyzeContract(id)
    expect(report.summary).toMatchObject({ verdict: 'compatible', callers: 0, broken: 0 })
  })

  it('names the caller, the node and the reference a removal breaks', () => {
    const calleeId = seed('Fulfilment', callee(SHAPE))
    seed('Orders', caller(calleeId, 'https://x.dev/{{call.orderId}}'))

    const report = analyzeContract(calleeId, callee('{"total": 10}'))
    expect(report.summary.verdict).toBe('breaking')
    expect(report.summary.broken).toBe(1)
    expect(report.callers[0].name).toBe('Orders')
    expect(report.callers[0].breaks[0]).toMatchObject({
      reference: 'call.orderId',
      label: 'Fulfil order',
      missing: 'orderId',
    })
  })

  it('suggests the field somebody probably meant when it was renamed', () => {
    const calleeId = seed('Renamed', callee(SHAPE))
    seed('Reader', caller(calleeId, '{{call.orderId}}'))
    const report = analyzeContract(calleeId, callee('{"order_id": "abc", "total": 10}'))
    expect(report.callers[0].breaks[0].suggestion).toBe('order_id')
  })

  it('separates a contract that narrowed from a caller that broke', () => {
    // The distinction the whole report is built on. The field is gone, so the
    // change is breaking — but nobody references it, so nothing is broken yet
    // and no deployment needs stopping.
    const calleeId = seed('Trimmed', callee(SHAPE))
    seed('Indifferent', caller(calleeId, 'https://x.dev/{{call.orderId}}'))

    const report = analyzeContract(calleeId, callee('{"orderId": "abc"}'))
    expect(report.change.verdict).toBe('breaking')
    expect(report.change.removed).toEqual([{ path: 'total', was: 'number' }])
    expect(report.summary.broken).toBe(0)
    expect(report.callers[0].breaks).toEqual([])
  })

  it('calls an added field additive and breaks nobody', () => {
    const calleeId = seed('Grown', callee(SHAPE))
    seed('Consumer', caller(calleeId, '{{call.orderId}}'))
    const report = analyzeContract(calleeId, callee('{"orderId": "abc", "total": 10, "carrier": "dhl"}'))
    expect(report.summary).toMatchObject({ verdict: 'additive', broken: 0 })
    expect(report.change.added).toEqual([{ path: 'carrier', now: 'string' }])
  })

  it('counts every broken reference, not just every broken caller', () => {
    const calleeId = seed('Multi', callee(SHAPE))
    seed('Heavy', {
      nodes: [
        node('t1', 'trigger-manual'),
        node('call', 'sub-workflow', { workflowId: calleeId }),
        node('a', 'action-http', { url: '{{call.orderId}}', body: '{{call.total}}' }),
      ],
      edges: [edge('t1', 'call'), edge('call', 'a')],
    })
    const report = analyzeContract(calleeId, callee('{"other": 1}'))
    expect(report.summary.broken).toBe(1)
    expect(report.summary.references).toBe(2)
  })

  it('lists an affected for-each caller without inventing a broken reference', () => {
    // Its output wraps the contract in `{ count, results: [T] }`, and a template
    // path cannot index an array — so the caller is affected and no specific
    // break can be named. Naming one would be fiction.
    const calleeId = seed('Fanned', callee(SHAPE))
    seed('Batch', caller(calleeId, '{{call.count}}', 'for-each'))
    const report = analyzeContract(calleeId, callee('{"other": 1}'))
    expect(report.callers.map((c) => c.name)).toEqual(['Batch'])
    expect(report.callers[0].breaks).toEqual([])
  })

  it('puts the callers that actually broke first', () => {
    const calleeId = seed('Popular', callee(SHAPE))
    seed('Aardvark', caller(calleeId, '{{call.total}}'))
    seed('Zebra', caller(calleeId, '{{call.orderId}}'))
    const report = analyzeContract(calleeId, callee('{"total": 10}'))
    // Zebra breaks and Aardvark does not, so alphabetical order loses to it.
    expect(report.callers.map((c) => c.name)).toEqual(['Zebra', 'Aardvark'])
  })

  it('stays inside the workspace', () => {
    const otherWs = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(otherWs, 'Other', userId, now, now)
    const calleeId = seed('Private', callee(SHAPE))
    seed('Outsider', caller(calleeId, '{{call.orderId}}'), otherWs)

    expect(analyzeContract(calleeId, callee('{"total": 10}')).callers).toEqual([])
  })

  it('ignores an error-handler edge, which never sees the return value', () => {
    // An error handler receives the *failure*, so nothing about the return
    // shape is a promise to it.
    const calleeId = seed('Handled', callee(SHAPE))
    const handlerId = seed('OnFail', callee('{"logged": true}'))
    db.prepare('UPDATE workflows SET error_workflow_id = ? WHERE id = ?').run(handlerId, calleeId)
    expect(analyzeContract(handlerId, callee('{"other": 1}')).callers).toEqual([])
  })

  it('reports the shape either side of the change, so the diff reads', () => {
    const calleeId = seed('Described', callee(SHAPE))
    const report = analyzeContract(calleeId, callee('{"orderId": "abc"}'))
    expect(report.before.fields).toEqual(['orderId', 'total'])
    expect(report.after.fields).toEqual(['orderId'])
  })

  it('refuses a workflow whose stored graph will not parse', () => {
    const id = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Broken', 'not json', 'draft', ?)`
    ).run(id, workspaceId, userId)
    expect(analyzeContract(id)).toMatchObject({ available: false, reason: 'unreadable' })
  })
})

describe('callersOf', () => {
  it('finds sub-workflow and for-each callers and nothing else', () => {
    const calleeId = seed('Target', callee(SHAPE))
    seed('ViaSub', caller(calleeId, '{{call.orderId}}'))
    seed('ViaEach', caller(calleeId, '{{call.count}}', 'for-each'))
    seed('Unrelated', callee('{"x": 1}'))
    expect(callersOf(calleeId, workspaceId).map((c) => c.name).sort()).toEqual([
      'ViaEach',
      'ViaSub',
    ])
  })

  it('skips a workflow whose graph will not parse rather than failing', () => {
    const calleeId = seed('Robust', callee(SHAPE))
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Junk', '{{{', 'draft', ?)`
    ).run(uuidv4(), workspaceId, userId)
    expect(() => callersOf(calleeId, workspaceId)).not.toThrow()
  })
})
