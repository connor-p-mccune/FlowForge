// Capacity analysis over real run history.
//
// The interesting property is that the model can be checked against the data it
// was measured from: `started_at − created_at` is the queueing delay, already
// recorded per run. So most of these tests are about the report being honest
// when the model is wrong, or when there is not enough history to know.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { analyzeCapacity, measure, MIN_RUNS } = require('../services/capacity')

const iso = (ms) => new Date(ms).toISOString()

function seedWorkflow({ cap = 2 } = {}) {
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
    `INSERT INTO workflows (id, workspace_id, name, graph_json, max_concurrent_runs,
                            created_by, created_at, updated_at)
     VALUES (?, ?, 'Orders', '{"nodes":[],"edges":[]}', ?, ?, ?, ?)`
  ).run(wfId, wsId, cap, userId, now, now)
  return { wfId, userId }
}

// `count` runs spread evenly over the window, each waiting `waitMs` and running
// for `serviceMs`.
function seedRuns(wfId, userId, { count, waitMs = 0, serviceMs = 60000, windowDays = 7, triggerType = null }) {
  const windowMs = windowDays * 86400000
  const now = Date.now()
  const gap = windowMs / (count + 1)
  const insert = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type,
                             created_at, started_at, finished_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`
  )
  for (let i = 0; i < count; i += 1) {
    const created = now - windowMs + gap * (i + 1)
    const started = created + (typeof waitMs === 'function' ? waitMs(i) : waitMs)
    const service = typeof serviceMs === 'function' ? serviceMs(i) : serviceMs
    insert.run(uuidv4(), wfId, userId, triggerType, iso(created), iso(started), iso(started + service))
  }
}

describe('analyzeCapacity', () => {
  it('refuses a workflow with too little history rather than guessing', () => {
    const { wfId, userId } = seedWorkflow()
    seedRuns(wfId, userId, { count: MIN_RUNS - 1 })
    const report = analyzeCapacity(wfId)
    expect(report.available).toBe(false)
    expect(report.reason).toBe('not-enough-runs')
    expect(report.needed).toBe(MIN_RUNS)
  })

  it('refuses a workflow with no cap, because it is not queueing', () => {
    const { wfId, userId } = seedWorkflow({ cap: null })
    seedRuns(wfId, userId, { count: 100 })
    expect(analyzeCapacity(wfId)).toMatchObject({ available: false, reason: 'no-cap' })
  })

  it('refuses an unknown workflow', () => {
    expect(analyzeCapacity(uuidv4())).toEqual({ available: false, reason: 'not-found' })
  })

  it('measures the arrival rate and the service time from history', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    // 168 runs over 7 days is one an hour.
    seedRuns(wfId, userId, { count: 168, serviceMs: 60000 })
    const { measured } = analyzeCapacity(wfId)
    expect(measured.arrivalsPerHour).toBeCloseTo(1, 1)
    expect(measured.serviceMeanMs).toBeCloseTo(60000, -2)
  })

  it('reports utilisation and headroom at the configured cap', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    // One arrival an hour holding a slot for 30 minutes = 0.5 erlangs into 4.
    seedRuns(wfId, userId, { count: 168, serviceMs: 30 * 60000 })
    const { current } = analyzeCapacity(wfId)
    expect(current.stable).toBe(true)
    expect(current.utilisation).toBeCloseTo(0.125, 2)
    expect(current.headroom).toBeCloseTo(8, 0)
  })

  it('calls an overloaded cap unstable rather than quoting a large wait', () => {
    // 168 arrivals an hour... at 2 hours of service each, into one slot.
    const { wfId, userId } = seedWorkflow({ cap: 1 })
    seedRuns(wfId, userId, { count: 168, serviceMs: 2 * 3600000 })
    const { current } = analyzeCapacity(wfId)
    expect(current.stable).toBe(false)
    expect(current.waitMeanMs).toBeNull()
    expect(current.headroom).toBeLessThan(1)
  })

  // — the part that makes the model checkable ————————————————————————

  it('checks its own prediction against the wait that was actually recorded', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 168, serviceMs: 30 * 60000, waitMs: 0 })
    const { calibration } = analyzeCapacity(wfId)
    // A lightly loaded queue: the model says ~no wait and history agrees. There
    // is nothing to calibrate against, and saying that is better than reporting
    // a ratio of two numbers that are both noise.
    expect(calibration.comparable).toBe(true)
    expect(calibration.verdict).toBe('no-queue-to-check')
  })

  it('says so when it predicts far less wait than actually happened', () => {
    // Every run waited ten minutes despite an almost idle cap — something the
    // model does not know about is holding runs up, and the honest report says
    // its own number is not to be trusted.
    const { wfId, userId } = seedWorkflow({ cap: 8 })
    seedRuns(wfId, userId, { count: 168, serviceMs: 60000, waitMs: 600000 })
    const { calibration, recommendation } = analyzeCapacity(wfId, { targetWaitMs: 1000 })
    expect(calibration.verdict).toBe('under-predicts')
    expect(calibration.ratio).toBeLessThan(0.5)
    // And the recommendation is downgraded rather than withheld: same number,
    // weaker claim.
    expect(recommendation.confident).toBe(false)
    expect(recommendation.servers).toBeGreaterThan(0)
  })

  it('needs enough recorded waits before it will compare at all', () => {
    const { wfId, userId } = seedWorkflow({ cap: 2 })
    seedRuns(wfId, userId, { count: 168, serviceMs: 60000 })
    // Strip started_at from all but a handful: those runs have no recorded wait.
    const ids = db.prepare('SELECT id FROM executions WHERE workflow_id = ?').all(wfId)
    const clear = db.prepare('UPDATE executions SET started_at = NULL WHERE id = ?')
    ids.slice(5).forEach((r) => clear.run(r.id))
    expect(analyzeCapacity(wfId).calibration).toMatchObject({
      comparable: false,
      verdict: 'not-enough-history',
    })
  })

  // — variability, which is the whole reason M/M/c is not used ————————

  it('measures the service variability rather than assuming it', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    // Most runs are fast; one in ten waits on a human for an hour. This is an
    // entirely ordinary workflow and its CV² is nowhere near exponential.
    seedRuns(wfId, userId, {
      count: 168,
      serviceMs: (i) => (i % 10 === 0 ? 3600000 : 30000),
    })
    const { measured, model } = analyzeCapacity(wfId)
    expect(measured.cvSquaredService).toBeGreaterThan(3)
    expect(model.variabilityFactor).toBeGreaterThan(2)
  })

  it('publishes what M/M/c would have said, so the assumption is visible', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, {
      count: 168,
      serviceMs: (i) => (i % 10 === 0 ? 3600000 : 30000),
    })
    const report = analyzeCapacity(wfId)
    // The exponential assumption under-predicts by the variability factor, and
    // the report shows both numbers rather than arguing about it.
    expect(report.current.waitMeanMs).toBeGreaterThan(report.model.mmcWaitMeanMs)
  })

  // — the counterfactual, which is the point ————————————————————————

  it('prices a range of caps around the current one', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 336, serviceMs: 45 * 60000 })
    const { curve } = analyzeCapacity(wfId)
    expect(curve.some((p) => p.servers === 4)).toBe(true)
    // Monotone: more slots never means more waiting.
    const stable = curve.filter((p) => p.stable)
    for (let i = 1; i < stable.length; i += 1) {
      expect(stable[i].waitMeanMs).toBeLessThanOrEqual(stable[i - 1].waitMeanMs)
    }
  })

  it('sizes a cap for a target wait and says how far off the current one is', () => {
    const { wfId, userId } = seedWorkflow({ cap: 1 })
    seedRuns(wfId, userId, { count: 336, serviceMs: 30 * 60000 })
    const { recommendation, cap } = analyzeCapacity(wfId, { targetWaitMs: 60000 })
    expect(recommendation.servers).toBeGreaterThan(cap)
    expect(recommendation.change).toBe(recommendation.servers - cap)
  })

  it('makes no recommendation when nobody asked for a target', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 168 })
    expect(analyzeCapacity(wfId).recommendation).toBeNull()
  })

  it('judges a hypothetical cap without changing the stored one', () => {
    const { wfId, userId } = seedWorkflow({ cap: 1 })
    seedRuns(wfId, userId, { count: 336, serviceMs: 30 * 60000 })
    const report = analyzeCapacity(wfId, { cap: 12 })
    expect(report.cap).toBe(12)
    expect(db.prepare('SELECT max_concurrent_runs c FROM workflows WHERE id = ?').get(wfId).c).toBe(1)
  })

  it('ignores dry runs, which never occupied a slot', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 168 })
    seedRuns(wfId, userId, { count: 500, triggerType: 'dry-run' })
    expect(analyzeCapacity(wfId).measured.arrivalsPerHour).toBeCloseTo(1, 1)
  })
})

describe('measure', () => {
  it('counts a still-queued run as an arrival but not as a wait', () => {
    // Its wait is censored — it is still accruing. Counting the time so far as
    // a completed wait would report a lower bound as a measurement, and
    // dropping it from arrivals would hide exactly the traffic a saturated
    // queue is drowning in.
    const created = Date.now() - 60000
    const rows = [
      { created_at: iso(created), started_at: iso(created + 1000), finished_at: iso(created + 5000) },
      { created_at: iso(created), started_at: null, finished_at: null },
    ]
    const m = measure(rows, 7)
    expect(m.runs).toBe(2)
    expect(m.sampled.wait).toBe(1)
    expect(m.sampled.service).toBe(1)
  })

  it('reports no service time at all rather than a zero', () => {
    const m = measure([{ created_at: iso(Date.now()), started_at: null, finished_at: null }], 7)
    expect(m.serviceMeanMs).toBeNull()
    expect(m.cvSquaredService).toBeNull()
  })
})

// The mean rate is the wrong statistic for deciding a cap, and it is wrong in
// the direction that matters. These tests pin the case the original report got
// wrong: comfortable on the average, diverging every Monday.
describe('analyzeCapacity — peak load', () => {
  // Steady background traffic plus one hour a week of ten times the volume.
  function seedBursty(wfId, userId) {
    const windowMs = 7 * 86400000
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at, started_at, finished_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    )
    const service = 10 * 60000 // ten minutes in a slot
    // 168 background runs — one an hour.
    for (let i = 0; i < 168; i += 1) {
      const created = now - windowMs + i * 3600000
      insert.run(uuidv4(), wfId, userId, iso(created), iso(created), iso(created + service))
    }
    // Plus 60 in a single hour, three days in.
    const burstStart = now - windowMs + 72 * 3600000
    for (let i = 0; i < 60; i += 1) {
      const created = burstStart + i * 55000
      insert.run(uuidv4(), wfId, userId, iso(created), iso(created), iso(created + service))
    }
  }

  it('measures the busiest hour, not just the average one', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedBursty(wfId, userId)
    const { measured } = analyzeCapacity(wfId)
    expect(measured.arrivalsPerHour).toBeCloseTo(1.36, 1)
    expect(measured.peakHour.perHour).toBeGreaterThan(50)
  })

  it('says when the peak was, so somebody recognises their own traffic', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedBursty(wfId, userId)
    expect(analyzeCapacity(wfId).measured.peakHour.startedAt).toMatch(/^\d{4}-/)
  })

  it('finds a cap that is comfortable on the mean and diverging at the peak', () => {
    // The whole point. 1.36 runs/hour × 10 minutes is 0.23 erlangs into 4 slots
    // — 6% utilised, nothing to see. 61 runs/hour × 10 minutes is 10 erlangs,
    // which four slots cannot absorb at all.
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedBursty(wfId, userId)
    const { current, peak } = analyzeCapacity(wfId)
    expect(current.stable).toBe(true)
    expect(current.utilisation).toBeLessThan(0.3)
    expect(peak.hour.stable).toBe(false)
  })

  it('separates a burst from sustained load', () => {
    // The busiest hour is about whether the queue absorbs a spike; the busiest
    // day is about what actually diverges. One burst does not move the day.
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedBursty(wfId, userId)
    const { peak } = analyzeCapacity(wfId)
    expect(peak.hour.utilisation).toBeGreaterThan(peak.day.utilisation)
    expect(peak.day.stable).toBe(true)
  })

  it('sizes the peak separately, because provisioning for it is a cost decision', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedBursty(wfId, userId)
    const { recommendation, peakRecommendation } = analyzeCapacity(wfId, { targetWaitMs: 30000 })
    expect(peakRecommendation.basis).toBe('busiest-hour')
    expect(peakRecommendation.servers).toBeGreaterThan(recommendation.servers)
  })

  it('agrees with the mean when traffic is exactly even', () => {
    // The property that makes it safe to report unconditionally: with no bursts
    // the peak says nothing the average did not.
    //
    // Seeded on the hour rather than reusing seedRuns, and the difference is
    // instructive. seedRuns spaces 168 runs over a week at 59.7-minute
    // intervals, so some one-hour windows genuinely contain two arrivals and the
    // peak is 2/hour against a mean of 1. That is not a defect — a rolling
    // maximum over an interval that does not divide the spacing really is above
    // the average — but it is not the property being asserted here.
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at, started_at, finished_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    )
    for (let i = 0; i < 168; i += 1) {
      const created = now - 7 * 86400000 + i * 3600000
      insert.run(uuidv4(), wfId, userId, iso(created), iso(created), iso(created + 60000))
    }
    const { measured } = analyzeCapacity(wfId)
    expect(measured.peakHour.perHour).toBeCloseTo(1, 9)
    expect(measured.arrivalsPerHour).toBeCloseTo(1, 1)
  })

  it('makes no peak recommendation when nobody asked for a target', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 168 })
    expect(analyzeCapacity(wfId).peakRecommendation).toBeNull()
  })
})

// The denominator is the period the workflow could actually receive traffic,
// not the nominal window — and the difference runs in the dangerous direction
// on exactly the workflows nobody has capacity data for yet.
describe('analyzeCapacity — a workflow younger than the window', () => {
  it('measures the rate over the runs it has, not over a window it did not exist for', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    // 72 runs across three days, asked about over a thirty-day window. The
    // honest rate is one an hour; dividing by thirty days would report a tenth
    // of that and make the cap look ten times safer than it is.
    seedRuns(wfId, userId, { count: 72, serviceMs: 60000, windowDays: 3 })
    const { measured } = analyzeCapacity(wfId, { windowDays: 30 })
    expect(measured.arrivalsPerHour).toBeCloseTo(1, 0)
    expect(measured.measuredOverDays).toBeLessThan(4)
  })

  it('uses the whole window once the workflow is older than it', () => {
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    seedRuns(wfId, userId, { count: 168, serviceMs: 60000, windowDays: 7 })
    expect(analyzeCapacity(wfId, { windowDays: 7 }).measured.measuredOverDays).toBeCloseTo(7, 0)
  })

  it('will not divide by almost nothing when every run landed in one minute', () => {
    // A burst inside a minute would otherwise report an arrival rate of
    // thousands per hour and declare every cap hopeless.
    const { wfId, userId } = seedWorkflow({ cap: 4 })
    const now = Date.now()
    const insert = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, created_at, started_at, finished_at)
       VALUES (?, ?, 'completed', ?, ?, ?, ?)`
    )
    for (let i = 0; i < 40; i += 1) {
      const created = now - 60000 + i * 1000
      insert.run(uuidv4(), wfId, userId, iso(created), iso(created), iso(created + 1000))
    }
    const { measured } = analyzeCapacity(wfId, { windowDays: 7 })
    expect(measured.measuredOverDays).toBeCloseTo(1 / 24, 2)
    expect(measured.arrivalsPerHour).toBeCloseTo(40, 0)
  })
})
