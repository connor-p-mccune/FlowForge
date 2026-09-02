// Everything fires at midnight.
//
// Every other timing analysis here is about one thing — the cap inside a run,
// the queue in front of a workflow, the longest chain in an execution. This is
// about the machine they share, and the load on it is not random: cron is
// written by people, and people write round numbers.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { analyzeSchedule, peakOverlap, bestShift, roundness } = require('../services/scheduleCollision')

const MIN = 60000
let userId
let wsId

beforeAll(() => {
  userId = uuidv4()
  wsId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
})

beforeEach(() => {
  db.prepare('DELETE FROM executions').run()
  db.prepare('DELETE FROM workflows WHERE workspace_id = ?').run(wsId)
})

// A deployed workflow with a schedule trigger, plus `runs` completed executions
// each lasting `durationMs`, so the analysis has a duration to occupy with.
function addScheduled(name, cron, { durationMs = 10 * MIN, runs = 5, timezone, paused = false } = {}) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, paused_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'deployed', ?, ?, ?, ?)`
  ).run(
    id,
    wsId,
    name,
    JSON.stringify({
      nodes: [
        {
          id: 't',
          type: 'trigger-schedule',
          position: { x: 0, y: 0 },
          data: { label: 'Every night', config: timezone ? { cron, timezone } : { cron } },
        },
      ],
      edges: [],
    }),
    paused ? now : null,
    userId,
    now,
    now
  )

  const insert = db.prepare(
    `INSERT INTO executions (id, workflow_id, status, created_at, started_at, finished_at)
     VALUES (?, ?, 'completed', ?, ?, ?)`
  )
  for (let i = 0; i < runs; i += 1) {
    const at = Date.now() - (i + 1) * 86400000
    insert.run(uuidv4(), id, new Date(at).toISOString(), new Date(at).toISOString(), new Date(at + durationMs).toISOString())
  }
  return id
}

const interval = (startMin, endMin, workflowId = 'w', name = workflowId) => ({
  workflowId,
  name,
  startMs: startMin * MIN,
  endMs: endMin * MIN,
})

describe('peakOverlap', () => {
  it('counts how many intervals are live at once, not how many start together', () => {
    // The 40-minute job that starts at midnight is still holding a worker when
    // the 00:30 job lands. Counting starts would miss that entirely.
    const peak = peakOverlap([interval(0, 40, 'a'), interval(30, 35, 'b'), interval(32, 60, 'c')])
    expect(peak.count).toBe(3)
    expect(peak.at).toBe(32 * MIN)
  })

  it('lets a run that ends exactly when another starts hand the slot over', () => {
    // Its worker is released before the next one needs it, so this is one at a
    // time rather than two.
    expect(peakOverlap([interval(0, 10, 'a'), interval(10, 20, 'b')]).count).toBe(1)
  })

  it('names the intervals that make up the peak', () => {
    const peak = peakOverlap([interval(0, 60, 'a'), interval(10, 20, 'b'), interval(90, 95, 'c')])
    expect(peak.intervals.map((i) => i.workflowId).sort()).toEqual(['a', 'b'])
  })

  it('reports nothing for an empty schedule', () => {
    expect(peakOverlap([])).toMatchObject({ count: 0, at: null })
  })
})

describe('roundness', () => {
  it('measures how much of the schedule lands on a round number', () => {
    // The finding, not a curiosity: a peak that is an accident of everyone
    // picking midnight has a cheap fix.
    const at = (h, m) => ({ startMs: Date.UTC(2026, 0, 1, h, m), endMs: 0, workflowId: 'w' })
    const r = roundness([at(0, 0), at(0, 0), at(3, 0), at(4, 17)])
    expect(r).toMatchObject({ occurrences: 4, onTheHour: 3, atMidnight: 2 })
    expect(r.share).toBeCloseTo(0.75, 3)
  })

  it('divides by nothing safely', () => {
    expect(roundness([]).share).toBe(0)
  })
})

describe('bestShift', () => {
  it('finds a move that flattens the peak', () => {
    const intervals = [interval(0, 5, 'a', 'Alpha'), interval(0, 5, 'b', 'Beta')]
    const shift = bestShift(intervals, peakOverlap(intervals))
    expect(shift).toMatchObject({ peakBefore: 2, peakAfter: 1 })
    expect(shift.minutes).toBeGreaterThan(0)
  })

  it('moves one workflow, not six', () => {
    // A report that suggested rescheduling everything at once is one nobody
    // acts on.
    const intervals = [interval(0, 5, 'a'), interval(0, 5, 'b'), interval(0, 5, 'c')]
    const shift = bestShift(intervals, peakOverlap(intervals))
    expect(typeof shift.workflowId).toBe('string')
  })

  it('suggests nothing when nothing collides', () => {
    const intervals = [interval(0, 5, 'a')]
    expect(bestShift(intervals, peakOverlap(intervals))).toBeNull()
  })

  it('suggests nothing when no shift inside the hour helps', () => {
    // Two hour-long jobs starting together cannot be separated by a move of
    // fifty-five minutes or less.
    const intervals = [interval(0, 120, 'a'), interval(0, 120, 'b')]
    expect(bestShift(intervals, peakOverlap(intervals))).toBeNull()
  })
})

describe('analyzeSchedule', () => {
  it('finds the peak a workspace of round-number crons produces', () => {
    addScheduled('Nightly reconcile', '0 0 * * *', { durationMs: 40 * MIN })
    addScheduled('Digest', '0 0 * * *', { durationMs: 20 * MIN })
    addScheduled('Cleanup', '0 0 * * *', { durationMs: 5 * MIN })

    const report = analyzeSchedule(wsId, { horizonDays: 2 })
    expect(report.available).toBe(true)
    expect(report.peak.concurrent).toBe(3)
    expect(report.peak.workflows.map((w) => w.name).sort()).toEqual([
      'Cleanup',
      'Digest',
      'Nightly reconcile',
    ])
  })

  it('says how much of the schedule is on the hour', () => {
    addScheduled('A', '0 * * * *')
    addScheduled('B', '17 * * * *')
    const { clock } = analyzeSchedule(wsId, { horizonDays: 1 })
    expect(clock.onTheHour).toBeGreaterThan(0)
    expect(clock.share).toBeCloseTo(0.5, 1)
  })

  it('suggests the one move that helps most', () => {
    addScheduled('Nightly reconcile', '0 0 * * *', { durationMs: 5 * MIN })
    addScheduled('Digest', '0 0 * * *', { durationMs: 5 * MIN })

    const { suggestion } = analyzeSchedule(wsId, { horizonDays: 2 })
    expect(suggestion).toMatchObject({ peakBefore: 2, peakAfter: 1 })
    expect(['Nightly reconcile', 'Digest']).toContain(suggestion.name)
  })

  it('does not collide two midnights in different time zones', () => {
    // The scheduler evaluates each cron in its own zone, so expanding
    // everything in UTC would invent a collision that never happens.
    addScheduled('Tokyo', '0 0 * * *', { durationMs: 5 * MIN, timezone: 'Asia/Tokyo' })
    addScheduled('London', '0 0 * * *', { durationMs: 5 * MIN, timezone: 'Europe/London' })

    expect(analyzeSchedule(wsId, { horizonDays: 2 }).peak.concurrent).toBe(1)
  })

  it('reports a lower bound when a scheduled workflow has never run', () => {
    // Substituting a nominal duration would produce a peak built partly out of
    // a number nobody measured.
    addScheduled('Measured', '0 0 * * *', { durationMs: 5 * MIN })
    addScheduled('Never run', '0 0 * * *', { runs: 0 })

    const report = analyzeSchedule(wsId, { horizonDays: 2 })
    expect(report.summary).toMatchObject({ unmeasured: 1, lowerBound: true })
    expect(report.unmeasured[0].name).toBe('Never run')
    expect(report.peak.concurrent).toBe(1)
  })

  it('ignores a paused workflow, which is not going to fire', () => {
    addScheduled('Live', '0 0 * * *', { durationMs: 5 * MIN })
    addScheduled('Paused', '0 0 * * *', { durationMs: 5 * MIN, paused: true })
    expect(analyzeSchedule(wsId, { horizonDays: 2 }).summary.scheduled).toBe(1)
  })

  it('ignores a workflow with no schedule trigger', () => {
    addScheduled('Scheduled', '0 0 * * *')
    const id = uuidv4()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Webhook only', '{"nodes":[{"id":"t","type":"trigger-webhook","data":{}}],"edges":[]}', 'deployed', ?)`
    ).run(id, wsId, userId)

    expect(analyzeSchedule(wsId, { horizonDays: 1 }).summary.scheduled).toBe(1)
  })

  it('judges against a capacity only when told one', () => {
    // Inventing a capacity would turn "here is your peak" into a verdict
    // nobody asked for.
    addScheduled('A', '0 0 * * *', { durationMs: 5 * MIN })
    addScheduled('B', '0 0 * * *', { durationMs: 5 * MIN })

    expect(analyzeSchedule(wsId, { horizonDays: 2 }).summary.overCapacity).toBeNull()
    expect(analyzeSchedule(wsId, { horizonDays: 2, capacity: 1 }).summary.overCapacity).toBe(true)
    expect(analyzeSchedule(wsId, { horizonDays: 2, capacity: 10 }).summary.overCapacity).toBe(false)
  })

  it('distinguishes no schedules from no measurements', () => {
    expect(analyzeSchedule(wsId).reason).toBe('no-schedules')

    addScheduled('Never run', '0 0 * * *', { runs: 0 })
    const report = analyzeSchedule(wsId)
    expect(report.reason).toBe('nothing-measured')
    expect(report.unmeasured).toHaveLength(1)
  })

  it('keeps each workspace to itself', () => {
    addScheduled('Ours', '0 0 * * *')
    const otherWs = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(otherWs, 'Other', userId, now, now)
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
       VALUES (?, ?, 'Theirs', ?, 'deployed', ?)`
    ).run(
      uuidv4(),
      otherWs,
      JSON.stringify({
        nodes: [{ id: 't', type: 'trigger-schedule', data: { config: { cron: '0 0 * * *' } } }],
        edges: [],
      }),
      userId
    )

    expect(analyzeSchedule(wsId, { horizonDays: 1 }).summary.scheduled).toBe(1)
  })

  it('survives a minutely schedule without expanding a week of it', () => {
    // 10,080 fires is a legitimate thing to have and not something to expand
    // one row at a time.
    addScheduled('Chatty', '* * * * *', { durationMs: 30000 })
    const report = analyzeSchedule(wsId, { horizonDays: 7 })
    expect(report.available).toBe(true)
    expect(report.summary.occurrences).toBeLessThanOrEqual(500)
  })
})

// The peak alone cannot say whether midnight is uniquely bad or just
// marginally the worst, and those want opposite responses: capacity for a
// plateau, a shifted cron for a spike.
describe('hourlyPeak', () => {
  const { hourlyPeak } = require('../services/scheduleCollision')
  const HOUR = 3600000
  const day = Date.UTC(2026, 8, 3)

  it('attributes a run to every hour it is live in', () => {
    // 23:30 to 01:30 touches 23, 00 and 01.
    const at = day + 23 * HOUR + 30 * 60000
    const byHour = hourlyPeak(
      [{ workflowId: 'a', startMs: at, endMs: at + 2 * HOUR }],
      day,
      3 * 86400000
    )
    expect(byHour[23]).toBe(1)
    expect(byHour[0]).toBe(1)
    expect(byHour[1]).toBe(1)
    expect(byHour[2]).toBe(0)
  })

  it('records the busiest each hour ever gets, not the last', () => {
    const byHour = hourlyPeak(
      [
        { workflowId: 'a', startMs: day, endMs: day + 10 * 60000 },
        { workflowId: 'b', startMs: day, endMs: day + 10 * 60000 },
        // The next day's midnight is quieter; the hour keeps its worst.
        { workflowId: 'c', startMs: day + 86400000, endMs: day + 86400000 + 10 * 60000 },
      ],
      day,
      3 * 86400000
    )
    expect(byHour[0]).toBe(2)
  })

  it('separates a spike from a plateau', () => {
    const spike = hourlyPeak(
      [
        { workflowId: 'a', startMs: day, endMs: day + 10 * 60000 },
        { workflowId: 'b', startMs: day, endMs: day + 10 * 60000 },
      ],
      day,
      86400000
    )
    expect(spike[0]).toBe(2)
    expect(spike.filter((n) => n > 0)).toHaveLength(1)

    // One long run all day is a plateau at 1, not a spike at anything.
    const plateau = hourlyPeak(
      [{ workflowId: 'a', startMs: day, endMs: day + 86400000 }],
      day,
      86400000
    )
    expect(plateau.every((n) => n === 1)).toBe(true)
  })

  it('has twenty-four zeroes for an empty schedule', () => {
    expect(hourlyPeak([], day, 86400000)).toEqual(new Array(24).fill(0))
  })

  it('rides along on the full report', () => {
    addScheduled('Nightly', '0 0 * * *', { durationMs: 30 * MIN })
    const { peak } = analyzeSchedule(wsId, { horizonDays: 2 })
    expect(peak.byHourUtc).toHaveLength(24)
    expect(peak.byHourUtc[0]).toBe(1)
  })
})
