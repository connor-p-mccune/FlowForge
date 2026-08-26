// The demo seed.
//
// It is worth testing for one reason: the data is shaped to *demonstrate*, and
// a demo that silently stops demonstrating is worse than none. Each of these
// pins one thing the seed exists to make visible — a queue that a capacity
// report can measure, step outputs a query can reach, a subject the erasure
// flow can find — so that a change to the generator which quietly empties a
// panel fails here instead of in front of somebody.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const db = require('../config/database')
const { seed, DEMO_EMAIL } = require('../db/seed')
const { analyzeCapacity } = require('../services/capacity')
const { queryRuns } = require('../services/runQuery')
const { reportFor } = require('../services/runAssertions')
const { accessReport } = require('../services/subjectRequests')

// A fortnight rather than the demo's ninety days: the properties below are
// about the *shape* of the data, and a shorter history demonstrates every one
// of them without spending half a minute of the suite generating rows.
const DAYS = 14
let result

beforeAll(() => {
  result = seed({ days: DAYS })
})

describe('seed', () => {
  it('creates a demo workspace with workflows, runs and steps', () => {
    expect(result.workflowCount).toBeGreaterThanOrEqual(5)
    expect(result.execCount).toBeGreaterThan(300)
    expect(result.stepCount).toBeGreaterThan(result.execCount)
  })

  it('is idempotent — re-running leaves one demo workspace', () => {
    // Re-seeding replaces the workspace, so the fixture is reassigned rather
    // than left pointing at ids that no longer exist.
    result = seed({ days: DAYS })
    const users = db.prepare('SELECT COUNT(*) n FROM users WHERE email = ?').get(DEMO_EMAIL).n
    expect(users).toBe(1)
    const spaces = db
      .prepare('SELECT COUNT(*) n FROM workspaces WHERE name = ?')
      .get('Demo Workspace').n
    expect(spaces).toBe(1)
  })

  it('records what each step produced, which is what a query can reach', () => {
    // Without outputs the only askable questions are about status and duration,
    // and the query engine has nothing to demonstrate.
    const withOutput = db
      .prepare("SELECT COUNT(*) n FROM execution_steps WHERE output_json IS NOT NULL AND status = 'succeeded'")
      .get().n
    expect(withOutput).toBeGreaterThan(300)
  })

  it('records a trigger payload, so trigger.… resolves', () => {
    const withPayload = db
      .prepare('SELECT COUNT(*) n FROM executions WHERE trigger_data IS NOT NULL')
      .get().n
    expect(withPayload).toBeGreaterThan(100)
  })
})

describe('seed — the capped workflow', () => {
  const capped = () =>
    db.prepare('SELECT * FROM workflows WHERE max_concurrent_runs IS NOT NULL').get()

  it('has a workflow with a concurrency cap', () => {
    expect(capped()).toBeTruthy()
  })

  it('produces runs that actually waited for a slot', () => {
    // The wait is *caused* by the cap — the seed runs the queue rather than
    // writing a plausible number into each row. Without it the capacity report
    // says "no queue to check" and demonstrates nothing.
    const queued = db
      .prepare(
        `SELECT COUNT(*) n FROM executions
         WHERE workflow_id = ? AND started_at > created_at`
      )
      .get(capped().id).n
    expect(queued).toBeGreaterThan(50)
  })

  it('gives the capacity report something to measure', () => {
    const report = analyzeCapacity(capped().id, { windowDays: DAYS })
    expect(report.available).toBe(true)
    expect(report.measured.observedWaitMeanMs).toBeGreaterThan(0)
    expect(report.measured.serviceMeanMs).toBeGreaterThan(60000)
  })

  it('has a peak hour above its own average', () => {
    // Arrivals follow a working day, so the busiest hour is a real peak rather
    // than noise — which is what the peak analysis exists to find.
    const report = analyzeCapacity(capped().id, { windowDays: DAYS })
    expect(report.measured.peakHour.perHour).toBeGreaterThan(
      report.measured.arrivalsPerHour * 2
    )
  })

  it('has a service time varied enough that M/M/c would be wrong', () => {
    // A human approval is what makes this so, and it is the argument the
    // capacity docs are built on. A CV² near zero here would quietly
    // demonstrate the well-behaved case instead.
    const report = analyzeCapacity(capped().id, { windowDays: DAYS })
    expect(report.measured.cvSquaredService).toBeGreaterThan(0.5)
  })
})

describe('seed — what the newer surfaces can find', () => {
  const refundId = () => result.workflowIds['Refund Approval']

  it('answers a query about a step output', () => {
    const found = queryRuns(refundId(), 'steps.refund.status == "failed"', { limit: 10 })
    expect(found.ok).toBe(true)
    expect(found.runs.length).toBeGreaterThan(0)
  })

  it('answers a query about the trigger payload', () => {
    // One order in twelve is large, so a threshold finds a minority rather than
    // everything or nothing.
    const large = queryRuns(refundId(), 'trigger.order.total > 1000', { limit: 10 })
    expect(large.runs.length).toBeGreaterThan(0)
    const all = queryRuns(refundId(), 'trigger.order.total > 0', { limit: 10 })
    expect(all.runs.length).toBeGreaterThan(0)
  })

  it('pins assertions whose states were computed, not written in', () => {
    const report = reportFor(refundId())
    expect(report.summary.total).toBe(2)
    // Evaluated over the real history through the same code path the engine's
    // terminal hook uses.
    expect(report.assertions.every((a) => a.checked > 100)).toBe(true)
    expect(report.summary.broken).toBe(0)
  })

  it('pins one assertion the data violates and one it does not', () => {
    const report = reportFor(refundId())
    const violated = report.assertions.filter((a) => a.violations > 0)
    const clean = report.assertions.filter((a) => a.violations === 0)
    expect(violated).toHaveLength(1)
    expect(clean).toHaveLength(1)
    expect(violated[0].lastViolationExecutionId).toBeTruthy()
  })

  it('indexes a data subject who appears across more than one workflow', () => {
    const held = accessReport(result.wsId, 'ada@northwind.example')
    expect(held.available).toBe(true)
    expect(held.summary.runs).toBeGreaterThan(0)
    expect(held.runs[0].trigger).toContain('ada@northwind.example')
  })

  it('keys the subject index on a hash, never the address', () => {
    const row = db
      .prepare('SELECT subject_id FROM executions WHERE subject_id IS NOT NULL LIMIT 1')
      .get()
    expect(row.subject_id).toMatch(/^[0-9a-f]{32}$/)
  })
})
