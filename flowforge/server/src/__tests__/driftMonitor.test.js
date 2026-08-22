// Drift monitoring end to end: build two windows from recorded step outputs,
// compare them, and alert once per distinct set of findings.
//
// The alerting half is the interesting one. Every other monitor here
// edge-triggers on a boolean — breached or not — and that is wrong for drift: a
// second field breaking while the first is still broken is new information and
// must alert. So the trigger is a fingerprint over *which* fields drifted, and
// these tests pin all four transitions it produces.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../services/activityService', () => ({ logEvent: jest.fn() }))
jest.mock('../services/notificationService', () => ({ createNotification: jest.fn() }))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const activityService = require('../services/activityService')
const notificationService = require('../services/notificationService')
const {
  analyzeWorkflowDrift,
  evaluateWorkflow,
  checkOnce,
  fingerprintOf,
} = require('../services/driftMonitor')

let userId
let workspaceId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'drift@test.com', 'x', 'Drift', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

beforeEach(() => {
  jest.clearAllMocks()
})

const GRAPH = {
  nodes: [
    { id: 'fetch', type: 'action-http', data: { label: 'Fetch orders' } },
    { id: 'log', type: 'output-log', data: { label: 'Log' } },
  ],
  edges: [{ source: 'fetch', target: 'log' }],
}

function createWorkflow(overrides = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, 'Orders', JSON.stringify(GRAPH), overrides.status || 'deployed', userId, now, now)
  if (overrides.drift_monitoring) {
    db.prepare('UPDATE workflows SET drift_monitoring = 1 WHERE id = ?').run(id)
  }
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)
}

// Seed `count` completed runs whose `fetch` step emitted `make(i)`. Runs are
// created oldest-first so `created_at` ordering matches the intended windows.
let clock = Date.parse('2026-01-01T00:00:00.000Z')
function seedRuns(workflowId, count, make, options = {}) {
  for (let i = 0; i < count; i++) {
    clock += 60_000
    const at = new Date(clock).toISOString()
    const execId = uuidv4()
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, triggered_by, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(execId, workflowId, options.status || 'completed', options.triggerType ?? 'api', userId, at, at, at)
    db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, output_json, started_at, finished_at)
       VALUES (?, ?, 'fetch', 'action-http', ?, ?, ?, ?)`
    ).run(uuidv4(), execId, options.stepStatus || 'succeeded', JSON.stringify(make(i)), at, at)
  }
}

describe('analyzeWorkflowDrift', () => {
  it('says so when there is not enough history rather than guessing', () => {
    const wf = createWorkflow()
    seedRuns(wf.id, 10, () => ({ amount: 100 }))
    const report = analyzeWorkflowDrift(wf.id)
    expect(report.available).toBe(false)
    expect(report.reason).toBe('insufficient-history')
    expect(report.have).toBe(10)
  })

  it('reports no findings for a workflow whose output has not changed', () => {
    const wf = createWorkflow()
    // Whole cycles in both windows, so the two samples really are from the same
    // distribution rather than two phases of the same sawtooth.
    seedRuns(wf.id, 120, (i) => ({ amount: 100 + (i % 40), status: 'ok', email: 'a@b.com' }))
    const report = analyzeWorkflowDrift(wf.id, { recentRuns: 40, baselineRuns: 80 })
    expect(report.available).toBe(true)
    expect(report.summary.major).toBe(0)
    expect(report.summary.minor).toBe(0)
    expect(report.fingerprint).toBeNull()
  })

  it('finds a field that started coming back null, and labels the node', () => {
    const wf = createWorkflow()
    seedRuns(wf.id, 70, () => ({ email: 'a@b.com' })) // baseline (older)
    seedRuns(wf.id, 50, (i) => ({ email: i % 10 < 4 ? null : 'a@b.com' })) // recent
    const report = analyzeWorkflowDrift(wf.id, { recentRuns: 50, baselineRuns: 70 })

    expect(report.available).toBe(true)
    const finding = report.nodes[0].findings.find((f) => f.kind === 'null-rate')
    expect(finding).toBeDefined()
    expect(finding.nodeId).toBe('fetch')
    expect(finding.nodeLabel).toBe('Fetch orders')
    expect(report.summary.major).toBeGreaterThan(0)
    expect(report.fingerprint).toEqual(expect.any(String))
  })

  it('reports the windows it compared', () => {
    const wf = createWorkflow()
    seedRuns(wf.id, 120, () => ({ amount: 1 }))
    const report = analyzeWorkflowDrift(wf.id, { recentRuns: 40, baselineRuns: 60 })
    expect(report.window.recent.runs).toBe(40)
    expect(report.window.baseline.runs).toBe(60)
    expect(new Date(report.window.recent.from) >= new Date(report.window.baseline.to)).toBe(true)
  })

  it('ignores dry runs — a simulated output is not production data', () => {
    const wf = createWorkflow()
    seedRuns(wf.id, 120, () => ({ amount: 1 }))
    seedRuns(wf.id, 200, () => ({ amount: 999999 }), { triggerType: 'dry-run' })
    const report = analyzeWorkflowDrift(wf.id, { recentRuns: 50, baselineRuns: 70 })
    expect(report.summary.major).toBe(0)
  })

  it('ignores reused steps, which carry an earlier run’s data', () => {
    // Letting them in would inject the baseline's own values into the window
    // being compared against the baseline — biasing every verdict toward
    // "nothing changed", the one direction a monitor must not fail in.
    const wf = createWorkflow()
    seedRuns(wf.id, 70, () => ({ email: 'a@b.com' }))
    seedRuns(wf.id, 50, () => ({ email: null }), { stepStatus: 'reused' })
    const report = analyzeWorkflowDrift(wf.id, { recentRuns: 50, baselineRuns: 70 })
    // Every recent step was reused, so the recent window has no profile for the
    // node at all and there is nothing to compare.
    expect(report.summary.major).toBe(0)
  })

  it('ignores failed steps, whose output is an error rather than data', () => {
    const wf = createWorkflow()
    seedRuns(wf.id, 70, () => ({ email: 'a@b.com' }))
    seedRuns(wf.id, 50, () => ({ failed: true, error: 'boom' }), { stepStatus: 'failed' })
    expect(analyzeWorkflowDrift(wf.id, { recentRuns: 50, baselineRuns: 70 }).summary.major).toBe(0)
  })

  it('is unavailable for a workflow that does not exist', () => {
    expect(analyzeWorkflowDrift(uuidv4())).toEqual({ available: false, reason: 'not-found' })
  })
})

describe('fingerprintOf', () => {
  it('is null when nothing major drifted', () => {
    expect(fingerprintOf([])).toBeNull()
    expect(fingerprintOf([{ severity: 'minor', nodeId: 'a', path: 'x', kind: 'null-rate' }])).toBeNull()
  })

  it('is stable regardless of the order findings arrive in', () => {
    const a = { severity: 'major', nodeId: 'n1', path: 'email', kind: 'null-rate' }
    const b = { severity: 'major', nodeId: 'n2', path: 'total', kind: 'distribution' }
    expect(fingerprintOf([a, b])).toBe(fingerprintOf([b, a]))
  })

  it('changes when a different field drifts', () => {
    const a = { severity: 'major', nodeId: 'n1', path: 'email', kind: 'null-rate' }
    const b = { severity: 'major', nodeId: 'n1', path: 'phone', kind: 'null-rate' }
    expect(fingerprintOf([a])).not.toBe(fingerprintOf([b]))
  })
})

describe('alerting', () => {
  function driftedWorkflow() {
    const wf = createWorkflow({ drift_monitoring: true })
    seedRuns(wf.id, 70, () => ({ email: 'a@b.com' }))
    seedRuns(wf.id, 50, (i) => ({ email: i % 10 < 6 ? null : 'a@b.com' }))
    return wf
  }

  const opts = { recentRuns: 50, baselineRuns: 70 }
  const reload = (id) => db.prepare('SELECT * FROM workflows WHERE id = ?').get(id)

  it('raises one alert on the first detection', () => {
    const wf = driftedWorkflow()
    expect(evaluateWorkflow(wf, opts)).toBe('detected')

    expect(activityService.logEvent).toHaveBeenCalledTimes(1)
    const [, , eventType, payload] = activityService.logEvent.mock.calls[0]
    expect(eventType).toBe('workflow.data_drift')
    expect(payload.metadata.findings[0].nodeLabel).toBe('Fetch orders')
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1)

    const after = reload(wf.id)
    expect(after.drift_alerted_at).toEqual(expect.any(String))
    expect(after.drift_fingerprint).toEqual(expect.any(String))
  })

  it('stays silent while exactly the same drift persists', () => {
    const wf = driftedWorkflow()
    evaluateWorkflow(wf, opts)
    jest.clearAllMocks()

    expect(evaluateWorkflow(reload(wf.id), opts)).toBeNull()
    expect(activityService.logEvent).not.toHaveBeenCalled()
  })

  it('alerts again when a second field breaks', () => {
    const wf = driftedWorkflow()
    evaluateWorkflow(wf, opts)
    jest.clearAllMocks()

    // A different field now drifts too — new information, so it must alert
    // even though the workflow was already in an alerting state.
    seedRuns(wf.id, 50, (i) => ({
      email: i % 10 < 6 ? null : 'a@b.com',
      phone: i % 10 < 8 ? null : '0123',
    }))
    expect(evaluateWorkflow(reload(wf.id), opts)).toBe('changed')
    expect(activityService.logEvent).toHaveBeenCalledTimes(1)
  })

  it('keeps quiet while the fix is still inside the baseline', () => {
    // The baseline is the workflow's own recent past, so immediately after a
    // fix the *baseline* is the broken period and the recent window is the
    // healthy one — which is still a change, and still the same field. The
    // fingerprint is unchanged, so no second alert fires.
    const wf = driftedWorkflow()
    evaluateWorkflow(wf, opts)
    jest.clearAllMocks()

    seedRuns(wf.id, 50, () => ({ email: 'a@b.com' }))
    expect(evaluateWorkflow(reload(wf.id), opts)).toBeNull()
    expect(activityService.logEvent).not.toHaveBeenCalled()
    expect(reload(wf.id).drift_alerted_at).toEqual(expect.any(String))
  })

  it('closes the incident once the drift has aged out of both windows', () => {
    const wf = driftedWorkflow()
    evaluateWorkflow(wf, opts)
    jest.clearAllMocks()

    // Enough healthy runs to fill the recent window *and* the baseline behind
    // it: the incident closes when the data has genuinely been normal for a
    // full baseline, not the moment somebody deployed a fix.
    seedRuns(wf.id, 130, () => ({ email: 'a@b.com' }))
    expect(evaluateWorkflow(reload(wf.id), opts)).toBe('recovered')
    expect(activityService.logEvent.mock.calls[0][2]).toBe('workflow.data_drift_recovered')

    const after = reload(wf.id)
    expect(after.drift_alerted_at).toBeNull()
    expect(after.drift_fingerprint).toBeNull()
  })

  it('records the check even when there is nothing to analyse', () => {
    const wf = createWorkflow({ drift_monitoring: true })
    seedRuns(wf.id, 5, () => ({ a: 1 }))
    expect(evaluateWorkflow(wf, opts)).toBeNull()
    expect(reload(wf.id).drift_checked_at).toEqual(expect.any(String))
    expect(activityService.logEvent).not.toHaveBeenCalled()
  })
})

describe('checkOnce', () => {
  it('visits only deployed workflows that opted in', () => {
    const optedOut = createWorkflow()
    const draft = createWorkflow({ drift_monitoring: true, status: 'draft' })
    const watched = createWorkflow({ drift_monitoring: true })
    for (const wf of [optedOut, draft, watched]) {
      seedRuns(wf.id, 70, () => ({ email: 'a@b.com' }))
      seedRuns(wf.id, 50, (i) => ({ email: i % 10 < 6 ? null : 'a@b.com' }))
    }

    const transitions = checkOnce({ force: true, recentRuns: 50, baselineRuns: 70 })
    const visited = transitions.map((t) => t.workflowId)
    expect(visited).toContain(watched.id)
    expect(visited).not.toContain(optedOut.id)
    expect(visited).not.toContain(draft.id)
  })

  it('throttles: a workflow just checked is not re-analysed', () => {
    const wf = createWorkflow({ drift_monitoring: true })
    seedRuns(wf.id, 70, () => ({ email: 'a@b.com' }))
    seedRuns(wf.id, 50, (i) => ({ email: i % 10 < 6 ? null : 'a@b.com' }))

    checkOnce({ force: true, recentRuns: 50, baselineRuns: 70 })
    jest.clearAllMocks()
    // Without `force`, the throttle window has not elapsed.
    expect(checkOnce({ recentRuns: 50, baselineRuns: 70 })).toEqual([])
  })
})
