// Running the mutants against a workflow's own checks.
//
// The question the whole feature exists to answer is not "does this pass" but
// "would anything notice if it were wrong" — so the tests that matter are the
// ones where a suite passes on a broken graph, which is the gap nothing else in
// the product could report.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { analyzeMutations } = require('../services/mutationCheck')

const node = (id, type, config = {}, label = id) => ({
  id, type, position: { x: 0, y: 0 }, data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`, source, target, sourceHandle,
})

let userId
let workspaceId

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

// trigger → check → (true) tag → out
//                 → (false) skip → out
const GRAPH = {
  nodes: [
    node('t1', 'trigger-webhook'),
    node('check', 'condition', { operator: 'expression', expression: 'total > 100' }, 'Large order?'),
    node('tag', 'transform', { template: '{"tier": "large"}' }, 'Tag large'),
    node('skip', 'transform', { template: '{"tier": "small"}' }, 'Tag small'),
    node('out', 'output-return', { value: '{{tag}}' }, 'Return'),
  ],
  edges: [
    edge('t1', 'check'),
    edge('check', 'tag', 'true'),
    edge('check', 'skip', 'false'),
    edge('tag', 'out'),
    edge('skip', 'out'),
  ],
}

function seedWorkflow({ graph = GRAPH, guarantees = null } = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, guarantees_json,
                            created_by, created_at, updated_at)
     VALUES (?, ?, 'Orders', ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, JSON.stringify(graph), guarantees ? JSON.stringify(guarantees) : null, userId, now, now)
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
}

function addScenario(workflowId, { name, triggerData, assertions }) {
  db.prepare(
    `INSERT INTO workflow_tests (id, workflow_id, name, trigger_data, assertions, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(), workflowId, name,
    JSON.stringify(triggerData), JSON.stringify(assertions),
    userId, new Date().toISOString()
  )
}

const find = (report, operator) => report.mutants.filter((m) => m.operator === operator)

describe('analyzeMutations', () => {
  it('refuses a workflow with nothing to mutate', () => {
    const workflow = seedWorkflow({ graph: { nodes: [], edges: [] } })
    expect(analyzeMutations(workflow)).resolves.toMatchObject({ available: false, reason: 'empty' })
  })

  it('catches only what the linter catches when nobody wrote a check', async () => {
    // The honest baseline. A workflow with no scenarios and no guarantees is
    // covered by exactly one thing — the linter, which the author never had to
    // write — and everything it cannot see gets through.
    const workflow = seedWorkflow()
    const report = await analyzeMutations(workflow)
    expect(report.available).toBe(true)
    expect(report.scenarios).toBe(0)
    expect(report.summary.byTest).toBe(0)
    expect(report.summary.byGuarantee).toBe(0)
    expect(report.summary.survived).toBeGreaterThan(0)
    expect(report.summary.killed).toBe(report.summary.byLint)
  })

  // — the finding the whole feature exists for ——————————————————————

  it('reports a mutant a passing suite does not notice', async () => {
    // The suite asserts only that the run completed, which every mutant here
    // still does. Green, and covering nothing.
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'it runs',
      triggerData: { total: 500 },
      assertions: [{ expression: 'status == "completed"' }],
    })

    const report = await analyzeMutations(workflow)
    expect(report.scenarios).toBe(1)
    expect(report.summary.survived).toBeGreaterThan(0)
    const swapped = find(report, 'swap-branches')[0]
    expect(swapped.killed).toBe(false)
    expect(swapped.describe).toMatch(/wired backwards/)
  })

  it('kills a mutant a suite that asserts on the answer does notice', async () => {
    // The same graph, the same mutation, and a scenario that checks what the
    // workflow actually decided rather than that it finished.
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'a large order is tagged large',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })

    const report = await analyzeMutations(workflow)
    const swapped = find(report, 'swap-branches')[0]
    expect(swapped.killed).toBe(true)
    expect(swapped.by).toBe('test')
    expect(swapped.detail).toBe('a large order is tagged large')
  })

  it('names the scenario that did the killing', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'the useless one',
      triggerData: { total: 500 },
      assertions: [{ expression: 'status == "completed"' }],
    })
    addScenario(workflow.id, {
      name: 'the one that earns its place',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    const report = await analyzeMutations(workflow)
    expect(find(report, 'swap-branches')[0].detail).toBe('the one that earns its place')
  })

  // — the cheaper checks, which are tried first ————————————————————

  it('lets a declared guarantee kill a removed gate', async () => {
    // The operator that tells somebody whether declaring one was worth it.
    const gated = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve refund'),
        node('charge', 'action-http', { url: 'https://api.acme.com' }, 'Charge card'),
        node('decline', 'output-log', { message: 'no' }, 'Decline'),
      ],
      edges: [
        edge('t1', 'approve'),
        edge('approve', 'charge', 'true'),
        edge('approve', 'decline', 'false'),
      ],
    }
    const workflow = seedWorkflow({
      graph: gated,
      guarantees: [{ kind: 'requires', node: 'charge', other: 'approve' }],
    })

    const report = await analyzeMutations(workflow)
    const removed = find(report, 'remove-gate')[0]
    expect(removed.killed).toBe(true)
    expect(removed.by).toBe('guarantee')
  })

  it('survives the same removal when nobody declared the guarantee', async () => {
    const gated = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve refund'),
        node('charge', 'action-http', { url: 'https://api.acme.com' }, 'Charge card'),
        node('decline', 'output-log', { message: 'no' }, 'Decline'),
      ],
      edges: [
        edge('t1', 'approve'),
        edge('approve', 'charge', 'true'),
        edge('approve', 'decline', 'false'),
      ],
    }
    const workflow = seedWorkflow({ graph: gated })
    const report = await analyzeMutations(workflow)
    expect(find(report, 'remove-gate')[0].killed).toBe(false)
  })

  it('counts each kind of kill separately', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'checks the answer',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    const report = await analyzeMutations(workflow)
    expect(report.summary.byTest + report.summary.byGuarantee + report.summary.byLint)
      .toBe(report.summary.killed)
  })

  it('reports a score alongside the survivors it is a summary of', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'checks the answer',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    const report = await analyzeMutations(workflow)
    expect(report.summary.score).toBeGreaterThan(0)
    expect(report.summary.score).toBeLessThanOrEqual(100)
  })

  // — it leaves no trace ————————————————————————————————————————————

  it('deletes every dry run it made', async () => {
    // A mutation analysis should not appear in a workflow's history at all.
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'checks the answer',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    await analyzeMutations(workflow)
    const left = db
      .prepare('SELECT COUNT(*) n FROM executions WHERE workflow_id = ?')
      .get(workflow.id).n
    expect(left).toBe(0)
  })

  it('never touches the saved definition', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'checks the answer',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    await analyzeMutations(workflow)
    const after = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(workflow.id)
    expect(JSON.parse(after.graph_json)).toEqual(GRAPH)
  })

  it('respects the mutant cap', async () => {
    const workflow = seedWorkflow()
    const report = await analyzeMutations(workflow, { limit: 2 })
    expect(report.summary.total).toBe(2)
  })
})

// A survivor is a diagnosis. The input that would have caught it is the
// prescription, and it is where most coverage tools stop — "the threshold can
// be off by one and every test still passes" is true and leaves somebody asking
// what to write.
describe('analyzeMutations — witnesses', () => {
  it('gives a survivor the input that would have caught it', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'it runs',
      triggerData: { total: 500 },
      assertions: [{ expression: 'status == "completed"' }],
    })

    const report = await analyzeMutations(workflow)
    const offByOne = report.mutants.find((m) => m.operator === 'off-by-one' && !m.killed)
    expect(offByOne).toBeTruthy()
    // The boundary, not just any passing input — 500 is a value both graphs
    // agree about, and a generated test around it would pass on the bug.
    expect(offByOne.witness.triggerData.total).toBe(101)
  })

  it('says what to assert as well as what to send', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'it runs',
      triggerData: { total: 500 },
      assertions: [{ expression: 'status == "completed"' }],
    })
    const report = await analyzeMutations(workflow)
    const survivor = report.mutants.find((m) => !m.killed && m.suggestion)
    expect(survivor.suggestion).toBeTruthy()
  })

  it('spends no solver time on the mutants something already caught', async () => {
    const workflow = seedWorkflow()
    addScenario(workflow.id, {
      name: 'checks the answer',
      triggerData: { total: 500 },
      assertions: [{ expression: 'output.tier == "large"' }],
    })
    const report = await analyzeMutations(workflow)
    expect(report.mutants.filter((m) => m.killed).every((m) => !m.witness)).toBe(true)
  })

  it('counts how many survivors came with one', async () => {
    const workflow = seedWorkflow()
    const report = await analyzeMutations(workflow)
    expect(report.summary.witnessed).toBeLessThanOrEqual(report.summary.survived)
    expect(report.summary.witnessed).toBeGreaterThan(0)
  })
})
