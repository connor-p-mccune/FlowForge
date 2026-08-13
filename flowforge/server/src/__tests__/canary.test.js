// Progressive delivery: the traffic split, the statistical verdict, the four
// transitions, and the sweep that automates two of them.
//
// The property the whole feature rests on — stable executes a pinned snapshot
// while the canary executes the live canvas — is what makes rollback free, so
// several of these check that nothing moves when it shouldn't.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const canary = require('../services/canary')
const { sweepCanaries } = require('../services/canaryMonitor')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

const BASELINE_GRAPH = { nodes: [node('t', 'trigger-manual'), node('a', 'output-log', { message: 'v1' })], edges: [] }
const CANARY_GRAPH = { nodes: [node('t', 'trigger-manual'), node('a', 'output-log', { message: 'v2' })], edges: [] }

let token
let workspaceId
let workflowId

const authed = (req) => req.set('Authorization', `Bearer ${token}`)
const workflowRow = () => db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId)

async function setGraph(graph) {
  await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send(graph)
}

// Record `count` settled runs on a channel. Durations are spread deterministically
// around `durationMs` rather than being identical: real run times vary, and a
// column of byte-identical values would make the rank test's tie correction the
// thing under test instead of the comparison.
function seedRuns({ channel, count, failures = 0, durationMs = 1000, offsetMinutes = 0 }) {
  const insert = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, trigger_type, release_channel, created_at, started_at, finished_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`
  )
  for (let i = 0; i < count; i++) {
    const created = new Date(Date.now() + offsetMinutes * 60000).toISOString()
    const spread = (i % 10) * Math.round(durationMs / 20)
    const finished = new Date(new Date(created).getTime() + durationMs + spread).toISOString()
    insert.run(
      uuidv4(), workflowId, i < failures ? 'failed' : 'completed', channel, created, created, finished
    )
  }
}

async function startCanary(body = { percent: 20 }) {
  return authed(request(app).post(`/api/workflows/${workflowId}/canary`)).send(body)
}

beforeAll(async () => {
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'canary@example.com', password: 'password123', displayName: 'Canary' })
  token = reg.body.token
  const ws = await authed(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
  const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
    .send({ name: 'Release' })
  workflowId = wf.body.workflow.id
})

beforeEach(async () => {
  db.prepare('DELETE FROM executions WHERE workflow_id = ?').run(workflowId)
  db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflowId)
  db.prepare(
    `UPDATE workflows SET canary_baseline_version_id = NULL, canary_percent = NULL,
       canary_state = NULL, canary_started_at = NULL, canary_min_runs = NULL,
       canary_auto = NULL, status = 'draft' WHERE id = ?`
  ).run(workflowId)
  // Deploy v1 (the baseline), then edit the canvas into v2 (the canary).
  await setGraph(BASELINE_GRAPH)
  await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
  await setGraph(CANARY_GRAPH)
})

describe('starting a canary', () => {
  it('pins the last deploy as the baseline and leaves the canvas alone', async () => {
    const res = await startCanary({ percent: 25 })
    expect(res.status).toBe(201)
    expect(res.body.active).toBe(true)
    expect(res.body.percent).toBe(25)
    // The author's edits are untouched — the canary *is* the live canvas.
    expect(JSON.parse(workflowRow().graph_json)).toEqual(CANARY_GRAPH)
  })

  it('refuses a percentage outside 1–99', async () => {
    expect((await startCanary({ percent: 0 })).status).toBe(400)
    expect((await startCanary({ percent: 100 })).status).toBe(400)
    expect((await startCanary({ percent: 'lots' })).status).toBe(400)
  })

  it('refuses a workflow with no deployed version to compare against', async () => {
    db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflowId)
    const res = await startCanary({ percent: 10 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/no deployed version/)
  })

  it('refuses a second canary rather than silently replacing the first', async () => {
    await startCanary()
    expect((await startCanary()).status).toBe(409)
  })

  it('is refused by a policy that would block a deploy — 99% traffic is a deploy', async () => {
    await authed(request(app).post(`/api/workspaces/${workspaceId}/policies`)).send({
      name: 'Nothing ships',
      rule: 'false',
      message: 'No.',
      severity: 'deny',
    })
    const res = await startCanary({ percent: 99 })
    expect(res.status).toBe(422)
    db.prepare('DELETE FROM workspace_policies WHERE workspace_id = ?').run(workspaceId)
  })
})

describe('the traffic split', () => {
  const releaseFor = (overrides = {}) =>
    canary.resolveRelease({ id: 'e1', ...overrides }, workflowRow(), overrides.options || {})

  it('sends canary traffic to the live canvas and stable traffic to the baseline', async () => {
    await startCanary({ percent: 50 })
    const seen = new Set()
    for (let i = 0; i < 200; i++) seen.add(releaseFor().channel)
    expect(seen).toEqual(new Set(['canary', 'stable']))

    const canaryRelease = { ...releaseFor(), channel: 'canary' }
    void canaryRelease
    // Whichever arm, the graph matches its definition.
    for (let i = 0; i < 50; i++) {
      const release = releaseFor()
      const graph = JSON.parse(release.graphJson)
      const message = graph.nodes.find((n) => n.id === 'a').data.config.message
      expect(message).toBe(release.channel === 'canary' ? 'v2' : 'v1')
      expect(Boolean(release.versionId)).toBe(release.channel === 'stable')
    }
  })

  it('respects the percentage', async () => {
    await startCanary({ percent: 10 })
    let canaryCount = 0
    for (let i = 0; i < 2000; i++) if (releaseFor().channel === 'canary') canaryCount++
    // 10% of 2000 with generous slack — this is a fairness check, not a
    // distribution test.
    expect(canaryCount).toBeGreaterThan(120)
    expect(canaryCount).toBeLessThan(280)
  })

  it('keeps every run on the live canvas when there is no canary', () => {
    const release = releaseFor()
    expect(release.channel).toBeNull()
    expect(JSON.parse(release.graphJson)).toEqual(CANARY_GRAPH)
  })

  it('never puts a dry run in the experiment — test mode tries the canvas', async () => {
    await startCanary({ percent: 99 })
    for (let i = 0; i < 30; i++) {
      const release = canary.resolveRelease({ id: 'e' }, workflowRow(), { dryRun: true })
      expect(release.channel).toBeNull()
      expect(JSON.parse(release.graphJson)).toEqual(CANARY_GRAPH)
    }
  })

  it('never puts a debug run in the experiment either', async () => {
    // Two reasons, and both matter. Statistically, a run somebody paused at a
    // breakpoint for five minutes measures how long a person took to read a
    // JSON blob — feeding that into the Mann-Whitney comparison on durations
    // would let one debugging session veto a healthy release. Mechanically,
    // breakpoints are validated against the *live* graph at submission, so a
    // debug run assigned to the stable arm would execute a pinned baseline in
    // which those node ids may not exist and would simply never stop.
    await startCanary({ percent: 99 })
    const execution = { id: 'e', debug_json: JSON.stringify({ breakpoints: ['h1'] }) }
    for (let i = 0; i < 30; i++) {
      const release = canary.resolveRelease(execution, workflowRow(), {})
      expect(release.channel).toBeNull()
      expect(JSON.parse(release.graphJson)).toEqual(CANARY_GRAPH)
    }
  })

  it('makes a resumed run re-execute its source’s definition', async () => {
    await startCanary({ percent: 1 })
    const sourceId = uuidv4()
    const baselineVersionId = workflowRow().canary_baseline_version_id
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, release_channel, graph_version_id, created_at)
       VALUES (?, ?, 'failed', 'stable', ?, ?)`
    ).run(sourceId, workflowId, baselineVersionId, new Date().toISOString())

    // Reusing recorded step outputs across two different graphs would be
    // incoherent, so the assignment is inherited rather than re-rolled.
    for (let i = 0; i < 40; i++) {
      const release = canary.resolveRelease(
        { id: 'e2', resumed_from_execution_id: sourceId }, workflowRow()
      )
      expect(release.channel).toBe('stable')
      expect(JSON.parse(release.graphJson).nodes.find((n) => n.id === 'a').data.config.message).toBe('v1')
    }
  })

  it('degrades to the live graph when the baseline version has vanished', async () => {
    await startCanary({ percent: 50 })
    db.prepare('DELETE FROM workflow_versions WHERE workflow_id = ?').run(workflowId)
    const release = releaseFor()
    expect(release.channel).toBeNull()
    expect(JSON.parse(release.graphJson)).toEqual(CANARY_GRAPH)
  })

  it('honours an assignment already recorded on the row', async () => {
    await startCanary({ percent: 50 })
    const release = releaseFor({ release_channel: 'canary', graph_version_id: null })
    expect(release.channel).toBe('canary')
    expect(JSON.parse(release.graphJson)).toEqual(CANARY_GRAPH)
  })
})

describe('the verdict', () => {
  it('waits until the canary has enough runs of its own', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 5 })
    seedRuns({ channel: 'stable', count: 100 })
    const analysis = canary.analyze(workflowRow())
    expect(analysis.verdict).toBe('pending')
    expect(analysis.reason).toMatch(/5 of 20 canary runs/)
  })

  it('waits when there is no baseline to compare against', async () => {
    await startCanary({ percent: 50, minRuns: 10 })
    seedRuns({ channel: 'canary', count: 20 })
    seedRuns({ channel: 'stable', count: 3 })
    expect(canary.analyze(workflowRow()).reason).toMatch(/only 3 baseline runs/)
  })

  it('recommends promotion when nothing has regressed', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, failures: 2 })
    seedRuns({ channel: 'stable', count: 400, failures: 20 })
    const analysis = canary.analyze(workflowRow())
    expect(analysis.verdict).toBe('healthy')
    expect(analysis.recommendation).toBe('promote')
  })

  it('does not roll back on an unlucky streak that is not significant', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    // 7.5% vs 5.3% — looks worse, is three coin flips.
    seedRuns({ channel: 'canary', count: 40, failures: 3 })
    seedRuns({ channel: 'stable', count: 380, failures: 20 })
    expect(canary.analyze(workflowRow()).recommendation).toBe('promote')
  })

  it('rolls back on a failure rate that is significantly worse', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, failures: 20 })
    seedRuns({ channel: 'stable', count: 400, failures: 8 })
    const analysis = canary.analyze(workflowRow())
    expect(analysis.verdict).toBe('degraded')
    expect(analysis.recommendation).toBe('rollback')
    expect(analysis.reason).toMatch(/failure rate 50\.0% vs 2\.0%/)
  })

  it('rolls back on a duration regression even when nothing fails', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, durationMs: 9000 })
    seedRuns({ channel: 'stable', count: 100, durationMs: 1000 })
    const analysis = canary.analyze(workflowRow())
    expect(analysis.recommendation).toBe('rollback')
    expect(analysis.reason).toMatch(/significantly slower/)
  })

  it('short-circuits a total failure without waiting for the sample', async () => {
    await startCanary({ percent: 50, minRuns: 50 })
    seedRuns({ channel: 'canary', count: 4, failures: 4 })
    const analysis = canary.analyze(workflowRow())
    expect(analysis.verdict).toBe('failing')
    expect(analysis.recommendation).toBe('rollback')
    expect(analysis.reason).toMatch(/every canary run failed/)
  })

  it('reports a Wilson interval rather than implying certainty from zero failures', async () => {
    await startCanary({ percent: 50, minRuns: 5 })
    seedRuns({ channel: 'canary', count: 12 })
    const { canary: stats } = canary.analyze(workflowRow())
    expect(stats.failureRate).toBe(0)
    expect(stats.failureRateInterval.upper).toBeGreaterThan(0.1)
  })

  it('ignores cancelled runs and runs from before the canary started', async () => {
    await startCanary({ percent: 50, minRuns: 5 })
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, release_channel, created_at)
       VALUES (?, ?, 'cancelled', 'canary', ?)`
    ).run(uuidv4(), workflowId, new Date().toISOString())
    seedRuns({ channel: 'canary', count: 6, offsetMinutes: -60 })
    expect(canary.analyze(workflowRow()).canary.runs).toBe(0)
  })
})

describe('transitions', () => {
  it('promotes: the canvas becomes the deployed definition and the canary clears', async () => {
    await startCanary({ percent: 50 })
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/canary/promote`))
    expect(res.status).toBe(200)

    const after = workflowRow()
    expect(after.canary_state).toBeNull()
    expect(after.status).toBe('deployed')
    // The promotion is a deploy, so history shows a new version holding v2.
    const versions = db.prepare(
      'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version DESC'
    ).all(workflowId)
    expect(JSON.parse(versions[0].graph_json)).toEqual(CANARY_GRAPH)
    // Every run is back on the live canvas.
    expect(canary.resolveRelease({ id: 'e' }, after).channel).toBeNull()
  })

  it('rolls back without moving a single graph', async () => {
    await startCanary({ percent: 50 })
    const before = workflowRow().graph_json
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/canary/rollback`))
      .send({ reason: 'looks wrong' })
    expect(res.status).toBe(200)

    const after = workflowRow()
    // Stable was already on the baseline, so there is nothing to restore — the
    // author's edits survive for them to fix.
    expect(after.graph_json).toBe(before)
    expect(after.canary_state).toBe('rolled_back')
    expect(after.canary_percent).toBe(0)
    // And every run now takes the baseline.
    for (let i = 0; i < 30; i++) {
      expect(canary.resolveRelease({ id: 'e' }, after).channel).toBe('stable')
    }
  })

  it('resumes a rolled-back canary by ramping it, keeping the baseline', async () => {
    await startCanary({ percent: 50 })
    const baseline = workflowRow().canary_baseline_version_id
    await authed(request(app).post(`/api/workflows/${workflowId}/canary/rollback`)).send({})
    const res = await authed(request(app).put(`/api/workflows/${workflowId}/canary`)).send({ percent: 5 })
    expect(res.status).toBe(200)
    expect(workflowRow().canary_state).toBe('running')
    expect(workflowRow().canary_baseline_version_id).toBe(baseline)
  })

  it('abandons: the live canvas serves everything again', async () => {
    await startCanary({ percent: 50 })
    const res = await authed(request(app).delete(`/api/workflows/${workflowId}/canary`))
    expect(res.status).toBe(200)
    expect(workflowRow().canary_state).toBeNull()
    expect(canary.resolveRelease({ id: 'e' }, workflowRow()).channel).toBeNull()
  })

  it('refuses every transition when no canary is running', async () => {
    for (const path of ['/canary/promote', '/canary/rollback']) {
      expect((await authed(request(app).post(`/api/workflows/${workflowId}${path}`))).status).toBe(404)
    }
    expect((await authed(request(app).delete(`/api/workflows/${workflowId}/canary`))).status).toBe(404)
    expect((await authed(request(app).put(`/api/workflows/${workflowId}/canary`)).send({ percent: 5 })).status).toBe(404)
  })

  it('refuses a promotion a policy would block', async () => {
    await startCanary({ percent: 50 })
    await authed(request(app).post(`/api/workspaces/${workspaceId}/policies`)).send({
      name: 'Nothing promotes',
      rule: 'false',
      message: 'No.',
      severity: 'deny',
    })
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/canary/promote`))
    expect(res.status).toBe(422)
    db.prepare('DELETE FROM workspace_policies WHERE workspace_id = ?').run(workspaceId)
  })
})

describe('the automatic sweep', () => {
  it('rolls back a degraded canary and says why', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, failures: 20 })
    seedRuns({ channel: 'stable', count: 400, failures: 8 })

    sweepCanaries()
    expect(workflowRow().canary_state).toBe('rolled_back')
    const feed = await authed(request(app).get(`/api/workspaces/${workspaceId}/activity`))
    expect(feed.body.activity.map((e) => e.eventType || e.event_type))
      .toContain('workflow.canary_rolled_back')
  })

  it('promotes a healthy canary', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, failures: 2 })
    seedRuns({ channel: 'stable', count: 400, failures: 20 })

    sweepCanaries()
    const after = workflowRow()
    expect(after.canary_state).toBeNull()
    expect(after.status).toBe('deployed')
  })

  it('leaves a canary alone until it has earned a verdict', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 5 })
    sweepCanaries()
    expect(workflowRow().canary_state).toBe('running')
  })

  it('does nothing to a workflow that opted out of automation', async () => {
    await startCanary({ percent: 50, minRuns: 20, auto: false })
    seedRuns({ channel: 'canary', count: 40, failures: 20 })
    seedRuns({ channel: 'stable', count: 400, failures: 8 })
    sweepCanaries()
    expect(workflowRow().canary_state).toBe('running')
  })

  it('is idempotent — a second pass has nothing left to act on', async () => {
    await startCanary({ percent: 50, minRuns: 20 })
    seedRuns({ channel: 'canary', count: 40, failures: 20 })
    seedRuns({ channel: 'stable', count: 400, failures: 8 })
    sweepCanaries()
    const first = workflowRow()
    sweepCanaries()
    expect(workflowRow()).toEqual(first)
  })
})

describe('reading the canary', () => {
  it('reports inactive for a workflow with no experiment', async () => {
    const res = await authed(request(app).get(`/api/workflows/${workflowId}/canary`))
    expect(res.body).toMatchObject({ active: false })
  })

  it('404s for a non-member', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'canary-out@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .get(`/api/workflows/${workflowId}/canary`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
    expect(res.status).toBe(404)
  })
})

describe('duration comparison is resolution-honest', () => {
  it('does not read floating-point dust from julianday() as a slowdown', async () => {
    // Timestamps have millisecond resolution; julianday()'s subtraction leaves
    // sub-microsecond noise that varies with the absolute date. Two arms
    // necessarily occupy different time ranges, so unrounded durations could
    // make identical runs look systematically ordered.
    await startCanary({ percent: 50, minRuns: 20 })
    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, release_channel, created_at, started_at, finished_at)
       VALUES (?, ?, 'completed', 'manual', ?, ?, ?, ?)`
    )
    const seedIdentical = (channel, count, startOffsetMs) => {
      for (let i = 0; i < count; i++) {
        const created = new Date(Date.now() + startOffsetMs + i * 37).toISOString()
        const finished = new Date(new Date(created).getTime() + 1000).toISOString()
        insert.run(uuidv4(), workflowId, channel, created, created, finished)
      }
    }
    seedIdentical('canary', 40, 0)
    seedIdentical('stable', 400, 5000)

    const analysis = canary.analyze(workflowRow())
    expect(analysis.durationTest.significant).toBe(false)
    expect(analysis.recommendation).toBe('promote')
  })
})
