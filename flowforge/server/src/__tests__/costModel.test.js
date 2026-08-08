// Run cost accounting: pricing token usage, metering steps, and the budget
// that refuses runs once a workspace has spent its month's allowance.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
const mockPublish = jest.fn().mockResolvedValue(1)
jest.mock('../config/redis', () => ({ publish: (...a) => mockPublish(...a) }))

const { app } = require('../index')
const db = require('../config/database')
const costModel = require('../services/costModel')
const { budgetStatus, checkBudget, currentMonth } = require('../services/budget')

describe('priceUsage', () => {
  it('prices a known model from its token counts', () => {
    // gpt-4o-mini: $0.15 / 1M input, $0.60 / 1M output.
    // 1000 in + 500 out = 150 + 300 = 450 micro-USD.
    const priced = costModel.priceUsage({
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
    })
    expect(priced).toMatchObject({ microUsd: 450, priced: true })
  })

  it('matches a dated snapshot to its family by longest prefix', () => {
    // Providers return 'gpt-4o-mini-2024-07-18' for a 'gpt-4o-mini' request;
    // pricing has to follow the family rather than fall off the table.
    const snapshot = costModel.priceUsage({
      model: 'gpt-4o-mini-2024-07-18',
      promptTokens: 1000,
      completionTokens: 500,
    })
    expect(snapshot.microUsd).toBe(450)
    expect(snapshot.priced).toBe(true)
  })

  it('prefers the longest matching prefix, not the first', () => {
    // 'gpt-4o-mini' must not be priced as 'gpt-4o' — a 16x difference.
    const mini = costModel.priceUsage({ model: 'gpt-4o-mini', promptTokens: 1_000_000, completionTokens: 0 })
    const full = costModel.priceUsage({ model: 'gpt-4o', promptTokens: 1_000_000, completionTokens: 0 })
    expect(mini.microUsd).toBe(150_000)
    expect(full.microUsd).toBe(2_500_000)
  })

  it('reports an unknown model as unpriced rather than guessing', () => {
    // A visible gap beats a confident wrong number: every surface showing a
    // total can then say how much of it is unknown.
    const priced = costModel.priceUsage({
      model: 'some-future-model',
      promptTokens: 1000,
      completionTokens: 500,
    })
    expect(priced).toMatchObject({ microUsd: 0, priced: false })
  })

  it('never throws on a malformed usage object', () => {
    // Metering sits in the engine's hot path; a run must not fail because its
    // invoice line was unreadable.
    for (const bad of [null, undefined, {}, { promptTokens: 'lots' }, { model: 42 }]) {
      expect(() => costModel.priceUsage(bad)).not.toThrow()
      expect(costModel.priceUsage(bad).microUsd).toBe(0)
    }
  })

  it('honours a wholesale price-table override', () => {
    process.env.COST_MODEL_PRICES = JSON.stringify({ 'house-model': { input: 1000, output: 2000 } })
    try {
      const priced = costModel.priceUsage({
        model: 'house-model',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      })
      expect(priced).toMatchObject({ microUsd: 3000, priced: true })
    } finally {
      delete process.env.COST_MODEL_PRICES
    }
  })

  it('falls back to the built-in table when the override is unparseable', () => {
    process.env.COST_MODEL_PRICES = 'not json'
    try {
      expect(costModel.priceUsage({ model: 'gpt-4o-mini', promptTokens: 1_000_000 }).microUsd).toBe(
        150_000
      )
    } finally {
      delete process.env.COST_MODEL_PRICES
    }
  })
})

describe('meterStep', () => {
  it('meters an AI step from the usage its runner reported', () => {
    const metered = costModel.meterStep(
      { id: 'a1', type: 'ai-prompt' },
      { text: 'hi', usage: { model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 500 } }
    )
    expect(metered.microUsd).toBe(450)
    expect(metered.usage).toMatchObject({ kind: 'tokens', model: 'gpt-4o-mini', priced: true })
  })

  it('counts an external call without pricing it', () => {
    // FlowForge cannot know what a third-party API charges, and inventing a
    // number would make a total that looks authoritative and is fiction.
    const metered = costModel.meterStep({ id: 'h1', type: 'action-http' }, { status: 200 })
    expect(metered).toMatchObject({ microUsd: 0, usage: { kind: 'call', calls: 1, priced: false } })
  })

  it('prices an external call when the author declares a rate', () => {
    const metered = costModel.meterStep(
      { id: 'h1', type: 'action-http', data: { config: { costPerCall: 0.002 } } },
      { status: 200 }
    )
    expect(metered).toMatchObject({ microUsd: 2000, usage: { priced: true } })
  })

  it('reads the declared rate from raw config, so upstream data cannot set it', () => {
    // Same rule as the on-error policy and the cache policy: a routing or
    // accounting decision must not be something a payload can move.
    const metered = costModel.meterStep(
      { id: 'h1', type: 'action-http', data: { config: { costPerCall: '{{upstream.price}}' } } },
      { status: 200 }
    )
    expect(metered.microUsd).toBe(0)
  })

  it('meters nothing for a step that spends nothing', () => {
    expect(costModel.meterStep({ id: 't1', type: 'transform' }, { out: 1 })).toBeNull()
    expect(costModel.meterStep({ id: 'c1', type: 'condition' }, { result: 'true' })).toBeNull()
  })
})

describe('formatMicroUsd', () => {
  it('keeps four decimals below a dollar so sub-cent steps stay legible', () => {
    expect(costModel.formatMicroUsd(0)).toBe('$0.00')
    expect(costModel.formatMicroUsd(50)).toBe('<$0.0001')
    expect(costModel.formatMicroUsd(4200)).toBe('$0.0042')
    expect(costModel.formatMicroUsd(1_230_000)).toBe('$1.23')
  })
})

describe('budgets', () => {
  let token
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cost@example.com', password: 'password123', displayName: 'Cost' })
    token = reg.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Spender' })
    workflowId = wf.body.workflow.id
    // A runnable graph, so the execute route reaches the admission gate rather
    // than rejecting an empty workflow first.
    await request(app)
      .put(`/api/workflows/${workflowId}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        nodes: [
          { id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 'Start', config: {} } },
        ],
        edges: [],
      })
  })

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  // Record a settled run with a cost, the way the engine would.
  function spend(microUsd, { triggerType = 'manual', daysAgo = 0 } = {}) {
    const createdAt = new Date(Date.now() - daysAgo * 86400000).toISOString()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, cost_micro_usd, created_at)
       VALUES (?, ?, 'completed', ?, ?, ?)`
    ).run(`ex-${Math.random()}`, workflowId, triggerType, microUsd, createdAt)
  }

  beforeEach(() => {
    mockAdd.mockClear()
    db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(workflowId)
    // Warnings are workspace-scoped and edge-triggered on a column this reset
    // clears, so the feed rows have to go too or an earlier test's warning
    // counts against this one.
    db.prepare(
      "DELETE FROM activity_events WHERE workspace_id = ? AND event_type = 'workspace.budget_warning'"
    ).run(workspaceId)
    db.prepare(
      'UPDATE workspaces SET budget_micro_usd = NULL, budget_alert_pct = NULL, budget_alerted_month = NULL WHERE id = ?'
    ).run(workspaceId)
  })

  it('reports no cap and the month’s spend when no budget is set', () => {
    spend(1_500_000)
    const status = budgetStatus(workspaceId)
    expect(status).toMatchObject({ capMicroUsd: null, spentMicroUsd: 1_500_000, blocked: false })
    expect(status.month).toBe(currentMonth())
  })

  it('counts failed runs toward the spend', () => {
    // A run that failed after its AI call still spent the money; a budget that
    // only counted successes would be defeated by a workflow that dies last.
    spend(1_000_000)
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, cost_micro_usd, created_at)
       VALUES ('ex-failed', ?, 'failed', 'manual', 500000, ?)`
    ).run(workflowId, new Date().toISOString())
    expect(budgetStatus(workspaceId).spentMicroUsd).toBe(1_500_000)
  })

  it('excludes dry runs from the spend', () => {
    spend(1_000_000, { triggerType: 'dry-run' })
    expect(budgetStatus(workspaceId).spentMicroUsd).toBe(0)
  })

  it('admits a run under the cap and refuses one at it', () => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
    db.prepare('UPDATE workspaces SET budget_micro_usd = ? WHERE id = ?').run(10_000_000, workspaceId)

    spend(5_000_000)
    expect(checkBudget(workflow).ok).toBe(true)

    spend(5_000_000)
    const refusal = checkBudget(workflow)
    expect(refusal.ok).toBe(false)
    expect(refusal.reason).toBe('budget')
    expect(refusal.error).toMatch(/Workspace budget reached/)
  })

  it('refuses a run at the entry point once the budget is spent', async () => {
    db.prepare('UPDATE workspaces SET budget_micro_usd = ? WHERE id = ?').run(1_000_000, workspaceId)
    spend(2_000_000)

    const res = await authed(request(app).post(`/api/workflows/${workflowId}/execute`)).send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/budget/i)
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('still allows a dry run over budget, so the fix can be tested', async () => {
    // Blocking the person diagnosing the overspend would make the control
    // fight its own use case — the same reasoning pause follows.
    db.prepare('UPDATE workspaces SET budget_micro_usd = ? WHERE id = ?').run(1_000_000, workspaceId)
    spend(2_000_000)

    const res = await authed(request(app).post(`/api/workflows/${workflowId}/test`)).send({})
    expect(res.status).toBeLessThan(400)
  })

  it('warns once per month, not once per run', () => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
    db.prepare('UPDATE workspaces SET budget_micro_usd = ?, budget_alert_pct = ? WHERE id = ?')
      .run(10_000_000, 0.8, workspaceId)
    spend(9_000_000)

    checkBudget(workflow)
    checkBudget(workflow)
    checkBudget(workflow)

    const warnings = db
      .prepare(
        "SELECT COUNT(*) AS n FROM activity_events WHERE workspace_id = ? AND event_type = 'workspace.budget_warning'"
      )
      .get(workspaceId)
    expect(warnings.n).toBe(1)
    expect(
      db.prepare('SELECT budget_alerted_month FROM workspaces WHERE id = ?').get(workspaceId)
        .budget_alerted_month
    ).toBe(currentMonth())
  })

  it('sets and clears the budget through the API, owner-only', async () => {
    const set = await authed(request(app).put(`/api/workspaces/${workspaceId}/budget`)).send({
      capUsd: 25,
    })
    expect(set.status).toBe(200)
    expect(set.body.budget.capMicroUsd).toBe(25_000_000)

    const cleared = await authed(request(app).put(`/api/workspaces/${workspaceId}/budget`)).send({
      capUsd: null,
    })
    expect(cleared.body.budget.capMicroUsd).toBeNull()

    const bad = await authed(request(app).put(`/api/workspaces/${workspaceId}/budget`)).send({
      capUsd: -5,
    })
    expect(bad.status).toBe(400)
  })

  it('refuses a non-owner setting the budget but lets them read the costs', async () => {
    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'cost-member@example.com', password: 'password123', displayName: 'M' })
    await authed(request(app).post(`/api/workspaces/${workspaceId}/members`)).send({
      email: 'cost-member@example.com',
      role: 'member',
    })

    const write = await request(app)
      .put(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${member.body.token}`)
      .send({ capUsd: 1000 })
    expect(write.status).toBe(403)

    // Reading is deliberately open to members: knowing what the workflows you
    // build cost is part of building them well.
    const read = await request(app)
      .get(`/api/workspaces/${workspaceId}/costs`)
      .set('Authorization', `Bearer ${member.body.token}`)
    expect(read.status).toBe(200)
  })

  it('breaks spend down by workflow, day, and node type', async () => {
    spend(3_000_000)
    spend(1_000_000)

    const byWorkflow = await authed(request(app).get(`/api/workspaces/${workspaceId}/costs`))
    expect(byWorkflow.body.total).toBe(4_000_000)
    expect(byWorkflow.body.breakdown[0]).toMatchObject({ key: workflowId, display: '$4.00' })

    const byDay = await authed(
      request(app).get(`/api/workspaces/${workspaceId}/costs?groupBy=day`)
    )
    expect(byDay.body.groupBy).toBe('day')
    expect(byDay.body.breakdown.length).toBeGreaterThan(0)

    const byType = await authed(
      request(app).get(`/api/workspaces/${workspaceId}/costs?groupBy=nodeType`)
    )
    expect(byType.status).toBe(200)
    expect(byType.body.groupBy).toBe('nodeType')
  })
})
