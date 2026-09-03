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

// The seed's job is to be a believable workspace, and a believable workspace
// has the problems real ones have. These pin the ones the newer analyses exist
// to find — not because the demo needs them to look good, but because a report
// that finds nothing in the only data anybody runs it against is a report
// nobody can evaluate.
describe('seed — the problems a real workspace has', () => {
  const { analyzeSchedule } = require('../services/scheduleCollision')
  const { analyzeRepeats } = require('../services/repeats')
  const { subWorkflowGraphs } = require('../services/reachLookup')
  const { recoveryPolicy } = require('../services/crashRecovery')

  const wfNamed = (name) => db.prepare('SELECT * FROM workflows WHERE name = ?').get(name)

  it('deploys its workflows, because a workspace with history has', () => {
    const drafts = db
      .prepare("SELECT COUNT(*) n FROM workflows WHERE workspace_id = ? AND status != 'deployed'")
      .get(result.wsId).n
    expect(drafts).toBe(0)
  })

  it('schedules the workflow whose name says it is scheduled', () => {
    const digest = wfNamed('Daily Sales Digest')
    const { nodes } = JSON.parse(digest.graph_json)
    expect(nodes[0].type).toBe('trigger-schedule')
    expect(nodes[0].data.config.cron).toBe('0 0 * * *')
  })

  it('files its scheduled runs as scheduled', () => {
    // The query surfaces filter on trigger_type; seeding everything as one
    // value would make a real column look like it never varies.
    const kinds = db
      .prepare(
        `SELECT DISTINCT e.trigger_type t FROM executions e
           JOIN workflows w ON w.id = e.workflow_id
          WHERE w.workspace_id = ?`
      )
      .all(result.wsId)
      .map((r) => r.t)
      .sort()
    expect(kinds).toEqual(expect.arrayContaining(['schedule', 'webhook']))
    // Nothing in the demo is a dry run: those never occupied a slot, and the
    // capacity report excludes them for that reason.
    expect(kinds).not.toContain('dry-run')
  })

  it('lands its scheduled runs when the cron says, not across the afternoon', () => {
    const digest = wfNamed('Daily Sales Digest')
    const hours = db
      .prepare('SELECT created_at FROM executions WHERE workflow_id = ?')
      .all(digest.id)
      .map((r) => new Date(r.created_at).getUTCHours())
    expect(hours.length).toBeGreaterThan(0)
    expect(new Set(hours)).toEqual(new Set([0]))
  })

  it('collides two nightly jobs at midnight, which is what people schedule', () => {
    const report = analyzeSchedule(result.wsId, { horizonDays: 3 })
    expect(report.available).toBe(true)
    expect(report.peak.concurrent).toBeGreaterThanOrEqual(2)
    expect(new Date(report.peak.at).getUTCHours()).toBe(0)
    // And the report can do something about it.
    expect(report.suggestion.peakAfter).toBeLessThan(report.suggestion.peakBefore)
  })

  it('gives the repeat report a POST that is genuinely not safe to repeat', () => {
    const refund = wfNamed('Refund Approval')
    const resolve = subWorkflowGraphs(result.wsId)
    const report = analyzeRepeats(resolve(refund.id), resolve, {
      recoveryPolicy: recoveryPolicy(refund),
    })
    const charge = report.steps.find((s) => s.label === 'Issue Refund')
    expect(charge).toMatchObject({ verdict: 'unsafe', method: 'POST', retried: true })
    expect(report.summary.retriedUnsafe).toBeGreaterThan(0)
  })

  it('has a recovery policy the graph contradicts, made the way people make it', () => {
    // "It is a sync, syncs are idempotent" — over a POST with no key.
    const sync = wfNamed('Data Sync Job')
    expect(recoveryPolicy(sync)).toBe('resume')

    const resolve = subWorkflowGraphs(result.wsId)
    const report = analyzeRepeats(resolve(sync.id), resolve, { recoveryPolicy: 'resume' })
    expect(report.recovery.verdict).toBe('contradicted')
  })

  it('distinguishes a read from a write, so the report is not all one colour', () => {
    const sync = wfNamed('Data Sync Job')
    const resolve = subWorkflowGraphs(result.wsId)
    const verdicts = analyzeRepeats(resolve(sync.id), resolve).steps.map((s) => s.verdict).sort()
    expect(verdicts).toEqual(['safe', 'unsafe'])
  })
})

// A sub-workflow is one box on the canvas and an entire other workflow at run
// time, and three reports turn on that distinction. Without a call in the demo
// data all three answer honestly and say nothing.
describe('seed — across the sub-workflow boundary', () => {
  const { reachableEffects } = require('../services/reach')
  const { analyzeRepeats } = require('../services/repeats')
  const { exposureReport } = require('../services/exposure')
  const { subWorkflowGraphs } = require('../services/reachLookup')

  const resolve = () => subWorkflowGraphs(result.wsId)
  const wfNamed = (name) => db.prepare('SELECT * FROM workflows WHERE name = ?').get(name)

  it('gives every graph unique node ids', () => {
    // Two nodes sharing an id is not a graph, and the analyses that walk one
    // fail quietly rather than loudly.
    for (const w of db
      .prepare('SELECT name, graph_json FROM workflows WHERE workspace_id = ?')
      .all(result.wsId)) {
      const ids = JSON.parse(w.graph_json).nodes.map((n) => n.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('points each call at a workflow that is actually there', () => {
    const ids = new Set(
      db.prepare('SELECT id FROM workflows WHERE workspace_id = ?').all(result.wsId).map((r) => r.id)
    )
    let calls = 0
    for (const w of db
      .prepare('SELECT graph_json FROM workflows WHERE workspace_id = ?')
      .all(result.wsId)) {
      for (const n of JSON.parse(w.graph_json).nodes) {
        if (n.type !== 'sub-workflow') continue
        calls += 1
        expect(ids.has(n.data.config.workflowId)).toBe(true)
      }
    }
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('records a child run for each call, nested under the calling step', () => {
    const children = db
      .prepare(
        `SELECT COUNT(*) n FROM executions
          WHERE parent_execution_id IS NOT NULL AND parent_node_id IS NOT NULL`
      )
      .get().n
    expect(children).toBeGreaterThan(0)
    // And they are attributed to the callee, not to the caller.
    const callee = wfNamed('Notify Customer')
    const forCallee = db
      .prepare('SELECT COUNT(*) n FROM executions WHERE workflow_id = ? AND parent_execution_id IS NOT NULL')
      .get(callee.id).n
    expect(forCallee).toBe(children)
  })

  it('carries the caller’s gate onto an effect inside the callee', () => {
    // The conjunction the whole transitive report turns on: the email lives in
    // Notify Customer and is unconditional there, and it must not report as
    // `always` once it is reached through an approval.
    const refund = wfNamed('Refund Approval')
    const r = resolve()
    const reach = reachableEffects(r(refund.id), r)
    const inherited = reach.effects.find((e) => e.via.length > 0)
    expect(inherited).toBeTruthy()
    expect(inherited.always).toBe(false)
    expect(inherited.conditions.map((c) => c.label)).toContain('Approve Refund')
    expect(reach.summary.inherited).toBe(1)
  })

  it('inherits the callee’s worst repeat verdict at the call site', () => {
    const refund = wfNamed('Refund Approval')
    const r = resolve()
    const call = analyzeRepeats(r(refund.id), r).steps.find((s) => s.calls)
    expect(call).toMatchObject({ verdict: 'unsafe', retried: false })
    expect(call.calls.name).toBe('Notify Customer')
  })

  it('names the callers a shared workflow is reached through', () => {
    const row = exposureReport(result.wsId, { days: 30 }).workflows.find(
      (w) => w.name === 'Notify Customer'
    )
    expect(row.calledBy.sort()).toEqual(['Refund Approval', 'Support Ticket Router'])
    expect(row.runs.called).toBeGreaterThan(0)
  })

  it('counts what happens off the canvas', () => {
    expect(exposureReport(result.wsId, { days: 30 }).summary.offCanvas).toBeGreaterThan(0)
  })
})
