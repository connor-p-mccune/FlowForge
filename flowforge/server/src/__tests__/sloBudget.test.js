// SLO error budgets and multi-window burn-rate alerting.
//
// The arithmetic is the feature, so most of this file pins exact numbers: a
// burn rate that is off by a factor of the allowed failure rate looks plausible
// and is useless, and the only way to catch that is to compute it by hand here.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { objectiveFor, burnRate, evaluateBurn, computeSlo, MIN_RUNS_FOR_BURN } = require('../services/sloBudget')

const NOW = new Date('2026-08-06T12:00:00.000Z')

let token
let workspaceId
let workflowId

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'slo@example.com', password: 'password123', displayName: 'SLO' })
  token = reg.body.token
  const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  workspaceId = ws.body.workspaces[0].id
  const wf = await request(app)
    .post(`/api/workspaces/${workspaceId}/workflows`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Objective' })
  workflowId = wf.body.workflow.id
})

const authed = (req) => req.set('Authorization', `Bearer ${token}`)

// Record `count` settled runs `hoursAgo` before NOW.
function seedRuns({ status = 'completed', count = 1, hoursAgo = 0, triggerType = 'manual' } = {}) {
  const createdAt = new Date(NOW.getTime() - hoursAgo * 3600 * 1000).toISOString()
  const insert = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (let i = 0; i < count; i++) {
    insert.run(uuidv4(), workflowId, status, triggerType, createdAt, createdAt, createdAt)
  }
}

function setObjective(target, windowDays = 28) {
  db.prepare('UPDATE workflows SET slo_target = ?, slo_window_days = ? WHERE id = ?')
    .run(target, windowDays, workflowId)
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
}

beforeEach(() => {
  db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(workflowId)
  db.prepare('UPDATE workflows SET slo_target = NULL, slo_window_days = NULL WHERE id = ?')
    .run(workflowId)
})

describe('objectiveFor', () => {
  it('reads a target and defaults the window to 28 days', () => {
    expect(objectiveFor({ slo_target: 0.99 })).toEqual({
      target: 0.99,
      windowDays: 28,
      allowedFailureRate: expect.closeTo(0.01, 10),
    })
  })

  it('rejects a target of 1, which would have no error budget at all', () => {
    // Every burn rate would divide by zero — "never fail" is not an objective,
    // it's a wish.
    expect(objectiveFor({ slo_target: 1 })).toBeNull()
    expect(objectiveFor({ slo_target: 0 })).toBeNull()
    expect(objectiveFor({})).toBeNull()
    expect(objectiveFor({ slo_target: 'high' })).toBeNull()
  })
})

describe('burn rate', () => {
  it('is 1 when failures exactly match the allowance', () => {
    // A 99% objective allows 1% failures. 1 failure in 100 runs is a burn rate
    // of exactly 1 — the budget lasts precisely one window, which is what
    // choosing 99% *means*.
    seedRuns({ status: 'completed', count: 99, hoursAgo: 0.5 })
    seedRuns({ status: 'failed', count: 1, hoursAgo: 0.5 })
    const objective = objectiveFor({ slo_target: 0.99 })
    expect(burnRate(workflowId, 1, objective, NOW).rate).toBeCloseTo(1, 6)
  })

  it('scales linearly with the observed failure rate', () => {
    // 10 failures in 100 runs against a 1% allowance = 10× burn.
    seedRuns({ status: 'completed', count: 90, hoursAgo: 0.5 })
    seedRuns({ status: 'failed', count: 10, hoursAgo: 0.5 })
    const objective = objectiveFor({ slo_target: 0.99 })
    expect(burnRate(workflowId, 1, objective, NOW).rate).toBeCloseTo(10, 6)
  })

  it('returns null rather than zero when the window is too small to mean anything', () => {
    // "We are fine" and "we don't know" must not be the same value: two
    // failures out of three runs is a 67% failure rate and is not evidence.
    seedRuns({ status: 'failed', count: MIN_RUNS_FOR_BURN - 1, hoursAgo: 0.5 })
    const objective = objectiveFor({ slo_target: 0.99 })
    expect(burnRate(workflowId, 1, objective, NOW).rate).toBeNull()
  })

  it('ignores runs outside the window', () => {
    seedRuns({ status: 'failed', count: 50, hoursAgo: 10 }) // outside a 1h window
    seedRuns({ status: 'completed', count: 10, hoursAgo: 0.5 })
    const objective = objectiveFor({ slo_target: 0.99 })
    expect(burnRate(workflowId, 1, objective, NOW).rate).toBe(0)
  })

  it('ignores dry runs and cancelled runs', () => {
    // A test run is not production behaviour, and a person stopping a run is an
    // intervention rather than a service failure — charging it to the budget
    // would penalise exactly the response you want.
    seedRuns({ status: 'completed', count: 10, hoursAgo: 0.5 })
    seedRuns({ status: 'failed', count: 20, hoursAgo: 0.5, triggerType: 'dry-run' })
    seedRuns({ status: 'cancelled', count: 20, hoursAgo: 0.5 })
    const objective = objectiveFor({ slo_target: 0.99 })
    const result = burnRate(workflowId, 1, objective, NOW)
    expect(result.total).toBe(10)
    expect(result.rate).toBe(0)
  })
})

describe('multi-window alerting', () => {
  const objective = { target: 0.99, windowDays: 28, allowedFailureRate: 0.01 }

  it('does not fire on a short spike the long window does not confirm', () => {
    // Three failures in five minutes is a huge burn rate and usually nothing —
    // a deploy, a blip, a dependency that recovered on its own. Requiring the
    // long window to agree is the entire reason for two windows.
    seedRuns({ status: 'failed', count: 10, hoursAgo: 0.2 }) // inside 1h
    seedRuns({ status: 'completed', count: 5000, hoursAgo: 3 }) // dilutes 6h
    const tiers = evaluateBurn(workflowId, objective, NOW)
    const fast = tiers.find((t) => t.name === 'fast')
    expect(fast.shortRate).toBeGreaterThan(14.4)
    expect(fast.longRate).toBeLessThan(14.4)
    expect(fast.firing).toBe(false)
  })

  it('fires when both windows agree the burn is severe', () => {
    // A sustained 50% failure rate against a 1% allowance is 50× burn.
    seedRuns({ status: 'failed', count: 50, hoursAgo: 0.2 })
    seedRuns({ status: 'completed', count: 50, hoursAgo: 0.2 })
    seedRuns({ status: 'failed', count: 50, hoursAgo: 3 })
    seedRuns({ status: 'completed', count: 50, hoursAgo: 3 })
    const fast = evaluateBurn(workflowId, objective, NOW).find((t) => t.name === 'fast')
    expect(fast.shortRate).toBeCloseTo(50, 6)
    expect(fast.longRate).toBeCloseTo(50, 6)
    expect(fast.firing).toBe(true)
    expect(fast.severity).toBe('page')
  })

  it('fires the slow tier for a degradation the fast tier ignores', () => {
    // 10% failures = 10× burn: over the fast tier's 14.4 threshold? No. Over
    // the slow tier's 6? Yes. That gap is the point of having two tiers.
    seedRuns({ status: 'failed', count: 10, hoursAgo: 2 })
    seedRuns({ status: 'completed', count: 90, hoursAgo: 2 })
    seedRuns({ status: 'failed', count: 10, hoursAgo: 40 })
    seedRuns({ status: 'completed', count: 90, hoursAgo: 40 })
    const tiers = evaluateBurn(workflowId, objective, NOW)
    expect(tiers.find((t) => t.name === 'fast').firing).toBe(false)
    const slow = tiers.find((t) => t.name === 'slow')
    expect(slow.shortRate).toBeCloseTo(10, 6)
    expect(slow.firing).toBe(true)
    expect(slow.severity).toBe('ticket')
  })

  it('stays quiet when a workflow is meeting its objective', () => {
    seedRuns({ status: 'completed', count: 1000, hoursAgo: 0.5 })
    seedRuns({ status: 'failed', count: 5, hoursAgo: 0.5 })
    for (const tier of evaluateBurn(workflowId, objective, NOW)) {
      expect(tier.firing).toBe(false)
    }
  })
})

describe('computeSlo', () => {
  it('reports the budget in runs, not just a percentage', () => {
    // "10 failures left" is what an operator can act on.
    seedRuns({ status: 'completed', count: 990, hoursAgo: 24 })
    seedRuns({ status: 'failed', count: 4, hoursAgo: 24 })
    const slo = computeSlo(setObjective(0.99), NOW)
    expect(slo.runs).toBe(994)
    expect(slo.budgetRuns).toBeCloseTo(9.94, 6)
    expect(slo.failures).toBe(4)
    expect(slo.consumedFraction).toBeCloseTo(4 / 9.94, 6)
    expect(slo.remainingFraction).toBeCloseTo(1 - 4 / 9.94, 6)
    expect(slo.exhausted).toBe(false)
  })

  it('marks an exhausted budget without going negative on what remains', () => {
    seedRuns({ status: 'completed', count: 80, hoursAgo: 24 })
    seedRuns({ status: 'failed', count: 20, hoursAgo: 24 })
    const slo = computeSlo(setObjective(0.99), NOW)
    expect(slo.exhausted).toBe(true)
    expect(slo.consumedFraction).toBeGreaterThan(1)
    expect(slo.remainingFraction).toBe(0)
  })

  it('projects exhaustion from the sustained rate, not the jumpiest one', () => {
    // A projection built on the 1h window would swing between "fine" and "two
    // hours left" run to run, which is not a number anyone can act on — so the
    // estimate comes from the slow tier's 72h window.
    //
    // A long clean history keeps the budget mostly intact, while the last three
    // days burn at 5×: 5 failures in 100 runs against a 1% allowance.
    seedRuns({ status: 'completed', count: 10000, hoursAgo: 400 })
    seedRuns({ status: 'completed', count: 95, hoursAgo: 2 })
    seedRuns({ status: 'failed', count: 5, hoursAgo: 2 })

    const slo = computeSlo(setObjective(0.99), NOW)
    expect(slo.exhausted).toBe(false)
    // budget = 10100 * 0.01 = 101 runs; 5 spent → ~4.95% consumed.
    expect(slo.consumedFraction).toBeCloseTo(5 / 101, 6)
    // At 5× burn, the remaining 95% of a 672-hour budget lasts ~128 hours.
    expect(slo.exhaustsInHours).toBeCloseTo(((1 - 5 / 101) * 672) / 5, 3)
  })

  it('gives no projection once the budget is already gone', () => {
    // "Exhausted in N hours" is meaningless when it is exhausted now; the
    // `exhausted` flag is the answer, and a number here would invite someone to
    // read it as time remaining.
    seedRuns({ status: 'completed', count: 80, hoursAgo: 24 })
    seedRuns({ status: 'failed', count: 20, hoursAgo: 24 })
    const slo = computeSlo(setObjective(0.99), NOW)
    expect(slo.exhausted).toBe(true)
    expect(slo.exhaustsInHours).toBeNull()
  })

  it('reports not-configured for a workflow with no objective', () => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)
    expect(computeSlo(workflow, NOW)).toEqual({ configured: false })
  })

  it('handles a window with no runs without dividing by zero', () => {
    const slo = computeSlo(setObjective(0.99), NOW)
    expect(slo.runs).toBe(0)
    expect(slo.consumedFraction).toBe(0)
    expect(slo.exhausted).toBe(false)
  })
})

describe('SLO routes', () => {
  it('serves the budget for a workflow that declares an objective', async () => {
    seedRuns({ status: 'completed', count: 100, hoursAgo: 24 })
    setObjective(0.99, 14)
    const res = await authed(request(app).get(`/api/workflows/${workflowId}/slo`))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ configured: true, target: 0.99, windowDays: 14 })
    expect(res.body.burn).toHaveLength(2)
  })

  it('says so plainly when no objective is declared', async () => {
    const res = await authed(request(app).get(`/api/workflows/${workflowId}/slo`))
    expect(res.body.configured).toBe(false)
  })

  it('saves an objective and clears its window when the target is cleared', async () => {
    const set = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Objective',
      slo_target: 0.995,
      slo_window_days: 7,
    })
    expect(set.status).toBe(200)
    expect(set.body.workflow.slo_target).toBe(0.995)
    expect(set.body.workflow.slo_window_days).toBe(7)

    // Clearing the target clears the window with it — a window with no
    // objective to measure is config the next objective would silently inherit.
    const cleared = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Objective',
      slo_target: null,
    })
    expect(cleared.body.workflow.slo_target).toBeNull()
    expect(cleared.body.workflow.slo_window_days).toBeNull()
  })

  it('rejects an objective of 1 and an out-of-range window', async () => {
    const noBudget = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Objective',
      slo_target: 1,
    })
    expect(noBudget.status).toBe(400)
    expect(noBudget.body.error).toMatch(/strictly between 0 and 1/)

    const badWindow = await authed(request(app).put(`/api/workflows/${workflowId}`)).send({
      name: 'Objective',
      slo_target: 0.99,
      slo_window_days: 500,
    })
    expect(badWindow.status).toBe(400)
  })

  it('404s a workflow the caller cannot see', async () => {
    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'slo-stranger@example.com', password: 'password123', displayName: 'S' })
    const res = await request(app)
      .get(`/api/workflows/${workflowId}/slo`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
    expect(res.status).toBe(404)
  })
})
