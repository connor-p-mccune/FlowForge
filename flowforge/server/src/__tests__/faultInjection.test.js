// Deliberate fault injection: profile validation, the seeded draw, the safety
// boundaries, and the engine actually behaving differently when a profile is
// armed.
//
// The two properties that make this a tool rather than a hazard are tested
// hardest: a profile cannot touch a real run unless someone explicitly widened
// it, and the same run always produces the same faults.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { parseProfile, loadProfile, faultFor, draw } = require('../services/faultInjection')
const { runExecution } = require('../services/executionEngine')

const future = (ms = 3600_000) => new Date(Date.now() + ms).toISOString()

const VALID = {
  scope: 'dry-run',
  expiresAt: future(),
  rules: [{ mode: 'fail', nodeType: 'action-http', message: 'boom' }],
}

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

describe('parseProfile', () => {
  it('accepts a well-formed profile and defaults its scope to test runs', () => {
    const { profile } = parseProfile({ expiresAt: future(), rules: VALID.rules })
    expect(profile).toMatchObject({ enabled: true, scope: 'dry-run' })
    expect(profile.rules[0]).toMatchObject({ mode: 'fail', nodeType: 'action-http', probability: 1 })
  })

  it('requires an expiry — chaos is an experiment, not a setting', () => {
    expect(parseProfile({ rules: VALID.rules }).error).toMatch(/expiresAt is required/)
    expect(parseProfile({ ...VALID, expiresAt: 'soon' }).error).toMatch(/ISO-8601/)
    expect(parseProfile({ ...VALID, expiresAt: new Date(Date.now() - 1000).toISOString() }).error)
      .toMatch(/in the past/)
    expect(parseProfile({ ...VALID, expiresAt: future(30 * 86400_000) }).error).toMatch(/too far ahead/)
  })

  it('requires each rule to name what it targets', () => {
    // A profile that matched everything by omission is exactly the accident
    // this refuses.
    expect(parseProfile({ ...VALID, rules: [{ mode: 'fail' }] }).error)
      .toMatch(/needs a nodeId or a nodeType/)
  })

  it('refuses to target a trigger', () => {
    expect(parseProfile({ ...VALID, rules: [{ mode: 'fail', nodeType: 'trigger-manual' }] }).error)
      .toMatch(/trigger nodes cannot be targeted/)
  })

  it('validates each mode’s own parameters', () => {
    expect(parseProfile({ ...VALID, rules: [{ mode: 'nope', nodeId: 'a' }] }).error).toMatch(/mode must be/)
    expect(parseProfile({ ...VALID, rules: [{ mode: 'delay', nodeId: 'a' }] }).error).toMatch(/delayMs/)
    expect(parseProfile({ ...VALID, rules: [{ mode: 'delay', nodeId: 'a', delayMs: 999999 }] }).error)
      .toMatch(/delayMs/)
    expect(parseProfile({ ...VALID, rules: [{ mode: 'stub', nodeId: 'a' }] }).error).toMatch(/needs an output/)
    expect(parseProfile({ ...VALID, rules: [{ mode: 'stub', nodeId: 'a', output: [1] }] }).error)
      .toMatch(/JSON object/)
  })

  it('bounds the probability to (0, 1]', () => {
    expect(parseProfile({ ...VALID, rules: [{ ...VALID.rules[0], probability: 0 }] }).error)
      .toMatch(/probability/)
    expect(parseProfile({ ...VALID, rules: [{ ...VALID.rules[0], probability: 1.5 }] }).error)
      .toMatch(/probability/)
    expect(parseProfile({ ...VALID, rules: [{ ...VALID.rules[0], probability: 0.25 }] }).profile
      .rules[0].probability).toBe(0.25)
  })

  it('requires at least one rule and caps the list', () => {
    expect(parseProfile({ ...VALID, rules: [] }).error).toMatch(/at least one rule/)
    const many = new Array(21).fill(VALID.rules[0])
    expect(parseProfile({ ...VALID, rules: many }).error).toMatch(/at most 20 rules/)
  })

  it('refuses an unknown scope', () => {
    expect(parseProfile({ ...VALID, scope: 'production' }).error).toMatch(/scope must be/)
  })
})

describe('loadProfile', () => {
  it('reads an armed profile', () => {
    expect(loadProfile(JSON.stringify(parseProfile(VALID).profile))).toBeTruthy()
  })

  it('treats an expired profile as absent — expiry is the feature, not an error', () => {
    const expired = { ...parseProfile(VALID).profile, expiresAt: new Date(Date.now() - 1).toISOString() }
    expect(loadProfile(JSON.stringify(expired))).toBeNull()
  })

  it('treats a disabled or unparseable profile as absent', () => {
    expect(loadProfile(JSON.stringify({ ...parseProfile(VALID).profile, enabled: false }))).toBeNull()
    expect(loadProfile('{{{')).toBeNull()
    expect(loadProfile(null)).toBeNull()
  })
})

describe('faultFor', () => {
  const profile = (over = {}) => parseProfile({ ...VALID, ...over }).profile
  const http = node('h1', 'action-http')

  it('applies a matching rule', () => {
    const fault = faultFor(profile(), http, { executionId: 'e1', dryRun: true })
    expect(fault).toMatchObject({ mode: 'fail', message: 'boom' })
  })

  it('does not touch a real run unless the profile was widened to one', () => {
    // The safety property: writing a profile cannot break production by
    // accident.
    expect(faultFor(profile(), http, { executionId: 'e1', dryRun: false })).toBeNull()
    expect(faultFor(profile({ scope: 'all' }), http, { executionId: 'e1', dryRun: false }))
      .toBeTruthy()
  })

  it('never touches a trigger, whatever the rules say', () => {
    const wide = { ...profile(), rules: [{ mode: 'fail', nodeType: 'trigger-manual', probability: 1 }] }
    expect(faultFor(wide, node('t', 'trigger-manual'), { executionId: 'e1', dryRun: true })).toBeNull()
  })

  it('matches a specific node id ahead of a broad node type', () => {
    const ordered = profile({
      rules: [
        { mode: 'stub', nodeId: 'h1', output: { ok: true } },
        { mode: 'fail', nodeType: 'action-http' },
      ],
    })
    expect(faultFor(ordered, http, { executionId: 'e1', dryRun: true }).mode).toBe('stub')
    expect(faultFor(ordered, node('h2', 'action-http'), { executionId: 'e1', dryRun: true }).mode)
      .toBe('fail')
  })

  it('is deterministic for a given run — a replay reproduces the same faults', () => {
    // The whole reason the draw is seeded: a probability makes a chaos test
    // flaky and a chaos failure unreproducible unless the pattern is fixed.
    const flaky = profile({ rules: [{ mode: 'fail', nodeType: 'action-http', probability: 0.5 }] })
    const first = faultFor(flaky, http, { executionId: 'exec-A', dryRun: true })
    for (let i = 0; i < 20; i++) {
      expect(faultFor(flaky, http, { executionId: 'exec-A', dryRun: true })).toEqual(first)
    }
  })

  it('varies across runs and across nodes, so a probability still means something', () => {
    const flaky = profile({ rules: [{ mode: 'fail', nodeType: 'action-http', probability: 0.5 }] })
    let hits = 0
    for (let i = 0; i < 400; i++) {
      if (faultFor(flaky, http, { executionId: `exec-${i}`, dryRun: true })) hits++
    }
    // Roughly half, with generous slack — a fairness check, not a distribution
    // test.
    expect(hits).toBeGreaterThan(140)
    expect(hits).toBeLessThan(260)
  })

  it('returns null when nothing matches, or with no profile', () => {
    expect(faultFor(profile(), node('a', 'ai-prompt'), { executionId: 'e', dryRun: true })).toBeNull()
    expect(faultFor(null, http, { executionId: 'e', dryRun: true })).toBeNull()
  })
})

describe('draw', () => {
  it('lands in [0, 1) and is a pure function of its seed', () => {
    const a = draw(['x', 'y'])
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
    expect(draw(['x', 'y'])).toBe(a)
    expect(draw(['x', 'z'])).not.toBe(a)
  })
})

describe('the engine honours an armed profile', () => {
  let token
  let workspaceId
  let workflowId

  const authed = (req) => req.set('Authorization', `Bearer ${token}`)

  const GRAPH = {
    nodes: [
      node('t', 'trigger-manual'),
      node('h', 'action-http', { url: 'https://api.example.com/x' }),
      node('o', 'output-log', { message: 'done' }),
    ],
    edges: [
      { id: 'e1', source: 't', target: 'h' },
      { id: 'e2', source: 'h', target: 'o' },
    ],
  }

  async function runOnce({ dryRun }) {
    const executionId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, created_at)
       VALUES (?, ?, 'pending', ?, ?)`
    ).run(executionId, workflowId, dryRun ? 'dry-run' : 'manual', new Date().toISOString())
    await runExecution(executionId, { publish: () => {}, dryRun })
    return {
      execution: db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId),
      steps: db.prepare('SELECT * FROM execution_steps WHERE execution_id = ?').all(executionId),
    }
  }

  const stepFor = (steps, nodeId) => steps.find((s) => s.node_id === nodeId)

  async function arm(profile) {
    return authed(request(app).put(`/api/workflows/${workflowId}/chaos`)).send(profile)
  }

  beforeAll(async () => {
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'chaos@example.com', password: 'password123', displayName: 'Chaos' })
    token = reg.body.token
    const ws = await authed(request(app).get('/api/workspaces'))
    workspaceId = ws.body.workspaces[0].id
    const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Chaos target' })
    workflowId = wf.body.workflow.id
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(GRAPH)
  })

  beforeEach(() => {
    db.prepare('UPDATE workflows SET chaos_config = NULL WHERE id = ?').run(workflowId)
    db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(workflowId)
  })

  it('fails the targeted node, and says the failure was injected', async () => {
    await arm({ expiresAt: future(), rules: [{ mode: 'fail', nodeId: 'h', message: 'API down' }] })
    const { execution, steps } = await runOnce({ dryRun: true })
    expect(execution.status).toBe('failed')
    const step = stepFor(steps, 'h')
    expect(step.status).toBe('failed')
    // The timeline never disguises an injected fault as a real one.
    expect(step.error).toMatch(/\[chaos\] API down/)
    expect(stepFor(steps, 'o').status).toBe('skipped')
  })

  it('lets the on-error policy catch an injected failure, which is the point', async () => {
    // This is the assertion the feature exists to make possible: the error
    // branch someone wired up is exercised without breaking a real dependency.
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({
      nodes: [
        node('t', 'trigger-manual'),
        node('h', 'action-http', { url: 'https://api.example.com/x', onError: 'continue' }),
        node('o', 'output-log', { message: 'recovered' }),
      ],
      edges: GRAPH.edges,
    })
    await arm({ expiresAt: future(), rules: [{ mode: 'fail', nodeId: 'h' }] })

    const { execution, steps } = await runOnce({ dryRun: true })
    expect(execution.status).toBe('completed')
    expect(stepFor(steps, 'h').status).toBe('caught')
    expect(stepFor(steps, 'o').status).toBe('succeeded')

    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(GRAPH)
  })

  it('stubs a node’s output so downstream runs against canned data', async () => {
    await arm({
      expiresAt: future(),
      rules: [{ mode: 'stub', nodeId: 'h', output: { status: 503, body: 'unavailable' } }],
    })
    const { execution, steps } = await runOnce({ dryRun: true })
    expect(execution.status).toBe('completed')
    expect(JSON.parse(stepFor(steps, 'h').output_json)).toEqual({ status: 503, body: 'unavailable' })
  })

  it('delays a node without changing its result', async () => {
    await arm({ expiresAt: future(), rules: [{ mode: 'delay', nodeId: 'h', delayMs: 120 }] })
    const started = Date.now()
    const { execution } = await runOnce({ dryRun: true })
    expect(execution.status).toBe('completed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('leaves a real run untouched while the profile is scoped to test runs', async () => {
    // A graph with no outbound call, so a real run genuinely succeeds and the
    // absence of the fault is what is being observed.
    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({
      nodes: [node('t', 'trigger-manual'), node('h', 'transform', { template: '{"ok": true}' })],
      edges: [{ id: 'e1', source: 't', target: 'h' }],
    })
    await arm({ expiresAt: future(), rules: [{ mode: 'fail', nodeId: 'h' }] })

    const real = await runOnce({ dryRun: false })
    expect(real.execution.status).toBe('completed')

    // …while the same profile does fire on a test run, so the scope is what is
    // making the difference rather than the graph.
    const test = await runOnce({ dryRun: true })
    expect(test.execution.status).toBe('failed')
    expect(stepFor(test.steps, 'h').error).toMatch(/\[chaos\]/)

    await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(GRAPH)
  })

  it('stops applying once the profile has expired', async () => {
    await arm({ expiresAt: future(), rules: [{ mode: 'fail', nodeId: 'h' }] })
    // Reach past the API to expire it — the route refuses a past expiry, which
    // is itself the behaviour under test elsewhere.
    const stored = JSON.parse(db.prepare('SELECT chaos_config FROM workflows WHERE id = ?')
      .get(workflowId).chaos_config)
    db.prepare('UPDATE workflows SET chaos_config = ? WHERE id = ?').run(
      JSON.stringify({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      workflowId
    )
    const { execution } = await runOnce({ dryRun: true })
    expect(execution.status).toBe('completed')
  })
})

describe('the chaos routes', () => {
  let ownerToken
  let memberToken
  let workspaceId
  let workflowId

  const asOwner = (req) => req.set('Authorization', `Bearer ${ownerToken}`)
  const asMember = (req) => req.set('Authorization', `Bearer ${memberToken}`)

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'chaos-owner@example.com', password: 'password123', displayName: 'Owner' })
    ownerToken = owner.body.token
    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'chaos-member@example.com', password: 'password123', displayName: 'Member' })
    memberToken = member.body.token

    const ws = await asOwner(request(app).get('/api/workspaces'))
    workspaceId = ws.body.workspaces[0].id
    await asOwner(request(app).post(`/api/workspaces/${workspaceId}/members`))
      .send({ email: 'chaos-member@example.com', role: 'member' })
    const wf = await asOwner(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
      .send({ name: 'Routed' })
    workflowId = wf.body.workflow.id
  })

  beforeEach(() => {
    db.prepare('UPDATE workflows SET chaos_config = NULL WHERE id = ?').run(workflowId)
  })

  it('arms, reports, and disarms a profile', async () => {
    const armed = await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`)).send(VALID)
    expect(armed.status).toBe(200)
    expect(armed.body.active).toBe(true)

    const read = await asOwner(request(app).get(`/api/workflows/${workflowId}/chaos`))
    expect(read.body.profile.rules).toHaveLength(1)
    expect(read.body.active).toBe(true)

    const off = await asOwner(request(app).delete(`/api/workflows/${workflowId}/chaos`))
    expect(off.body.disarmed).toBe(true)
    expect((await asOwner(request(app).get(`/api/workflows/${workflowId}/chaos`))).body.profile)
      .toBeNull()
  })

  it('distinguishes "armed" from "in force" for an expired profile', async () => {
    // "I armed it, why is nothing failing?" needs a direct answer.
    await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`)).send(VALID)
    const stored = JSON.parse(db.prepare('SELECT chaos_config FROM workflows WHERE id = ?')
      .get(workflowId).chaos_config)
    db.prepare('UPDATE workflows SET chaos_config = ? WHERE id = ?').run(
      JSON.stringify({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() }),
      workflowId
    )
    const read = await asOwner(request(app).get(`/api/workflows/${workflowId}/chaos`))
    expect(read.body.profile).not.toBeNull()
    expect(read.body.active).toBe(false)
  })

  it('lets a member arm test-run chaos but not real-run chaos', async () => {
    expect((await asMember(request(app).put(`/api/workflows/${workflowId}/chaos`)).send(VALID)).status)
      .toBe(200)
    const wide = await asMember(request(app).put(`/api/workflows/${workflowId}/chaos`))
      .send({ ...VALID, scope: 'all' })
    expect(wide.status).toBe(403)
    expect((await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`))
      .send({ ...VALID, scope: 'all' })).status).toBe(200)
  })

  it('records arming and disarming in the audit log', async () => {
    await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`)).send(VALID)
    await asOwner(request(app).delete(`/api/workflows/${workflowId}/chaos`))
    const audit = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/audit`))
    const actions = audit.body.entries.map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['chaos.armed', 'chaos.disarmed']))
  })

  it('announces a real-run profile in the activity feed', async () => {
    await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`))
      .send({ ...VALID, scope: 'all' })
    const feed = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/activity`))
    expect(feed.body.activity.map((e) => e.eventType || e.event_type))
      .toContain('workflow.chaos_armed')
  })

  it('reports a malformed profile rather than storing something inert', async () => {
    const res = await asOwner(request(app).put(`/api/workflows/${workflowId}/chaos`))
      .send({ rules: [{ mode: 'fail', nodeId: 'h' }] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/expiresAt/)
  })

  it('is idempotent to disarm', async () => {
    expect((await asOwner(request(app).delete(`/api/workflows/${workflowId}/chaos`))).status).toBe(200)
  })

  it('404s for a non-member', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'chaos-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .get(`/api/workflows/${workflowId}/chaos`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
    expect(res.status).toBe(404)
  })
})
