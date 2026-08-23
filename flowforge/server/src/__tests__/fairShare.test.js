// Fair queueing between workflows.
//
// The property under test is max-min fairness: a workflow may start a run
// unless it is already more than `burst` runs ahead of the workflow that has
// had the fewest. The tests that matter most are the negative ones — that it
// costs nothing when nobody is waiting, that it never becomes starvation, and
// that it never reaches across priority lanes.

process.env.NODE_ENV = 'test'

const fairShare = require('../services/fairShare')

const BULK = 'wf-bulk'
const QUIET = 'wf-quiet'

// Simulate `n` admitted runs of a workflow in a lane.
const start = (workflowId, n, lane = 'normal') => {
  for (let i = 0; i < n; i++) fairShare.recordStart(workflowId, lane)
}

beforeEach(() => {
  fairShare.reset()
  delete process.env.DISABLE_FAIR_SHARE
  delete process.env.FAIR_SHARE_BURST
  delete process.env.FAIR_SHARE_WINDOW_MS
  delete process.env.FAIR_SHARE_MAX_DEFERRALS
})

describe('when nobody is waiting', () => {
  it('admits everything, however lopsided the traffic', () => {
    // A fairness control that taxed an idle system would be a latency
    // regression sold as a feature.
    start(BULK, 5000)
    expect(fairShare.admit(BULK).allowed).toBe(true)
  })

  it('admits a workflow with no history at all', () => {
    expect(fairShare.admit(QUIET).allowed).toBe(true)
  })

  it('ignores a contender that has stopped queueing', () => {
    process.env.FAIR_SHARE_WINDOW_MS = '2000'
    const now = Date.now()
    const spy = jest.spyOn(Date, 'now')

    spy.mockReturnValue(now)
    fairShare.recordDeferred(QUIET)
    start(BULK, 50)
    expect(fairShare.admit(BULK).allowed).toBe(false)

    // QUIET went home; a contender set that only grew would eventually make
    // every workflow look starved by one that is no longer there.
    spy.mockReturnValue(now + 3000)
    expect(fairShare.admit(BULK).allowed).toBe(true)
    spy.mockRestore()
  })
})

describe('when another workflow is waiting', () => {
  it('holds back the workflow that is far ahead', () => {
    fairShare.recordDeferred(QUIET)
    start(BULK, 50)
    const verdict = fairShare.admit(BULK)
    expect(verdict.allowed).toBe(false)
    expect(verdict.ahead).toBe(50)
    expect(verdict.floor).toBe(0)
  })

  it('lets the workflow that is behind straight through', () => {
    fairShare.recordDeferred(QUIET)
    start(BULK, 50)
    expect(fairShare.admit(QUIET).allowed).toBe(true)
  })

  it('allows a burst rather than strict round robin', () => {
    // Zero tolerance would ping-pong the queue on every job; a small burst
    // lets a workflow make real progress while still bounding how far ahead
    // it can get.
    fairShare.recordDeferred(QUIET)
    start(BULK, 3)
    expect(fairShare.admit(BULK).allowed).toBe(true) // 3 < 0 + 4
    start(BULK, 1)
    expect(fairShare.admit(BULK).allowed).toBe(false) // 4 is not < 4
  })

  it('honours a configured burst', () => {
    process.env.FAIR_SHARE_BURST = '10'
    fairShare.recordDeferred(QUIET)
    start(BULK, 9)
    expect(fairShare.admit(BULK).allowed).toBe(true)
    start(BULK, 1)
    expect(fairShare.admit(BULK).allowed).toBe(false)
  })

  it('measures against the least-served contender, not the average', () => {
    // Max-min fairness: the workflow that has had the fewest sets the floor,
    // so one heavily-served contender cannot mask a starved one.
    fairShare.recordDeferred(QUIET)
    fairShare.recordDeferred('wf-middling')
    start('wf-middling', 20)
    start(BULK, 10)
    // The floor is QUIET's zero, not the 15-run average.
    expect(fairShare.admit(BULK).allowed).toBe(false)
    expect(fairShare.admit(BULK).floor).toBe(0)
  })

  it('rebalances once the starved workflow catches up', () => {
    fairShare.recordDeferred(QUIET)
    start(BULK, 10)
    expect(fairShare.admit(BULK).allowed).toBe(false)

    start(QUIET, 10)
    // Starting clears QUIET from the waiting set — it no longer has work stuck
    // behind anybody — so BULK is unconstrained again.
    expect(fairShare.admit(BULK).allowed).toBe(true)
  })
})

describe('lanes', () => {
  it('never lets a normal-priority workflow hold up a high-priority one', () => {
    // Priority orders runs *between* lanes; fairness orders them within one.
    // Conflating the two would make a fairness control able to demote a run
    // somebody explicitly prioritised.
    fairShare.recordDeferred(QUIET, 'normal')
    start(BULK, 100, 'normal')
    expect(fairShare.admit(BULK, { lane: 'normal' }).allowed).toBe(false)
    expect(fairShare.admit(BULK, { lane: 'high' }).allowed).toBe(true)
  })

  it('keeps a separate ledger per lane', () => {
    start(BULK, 100, 'low')
    fairShare.recordDeferred(QUIET, 'normal')
    expect(fairShare.snapshot('low').admitted[BULK]).toBe(100)
    expect(fairShare.snapshot('normal').admitted[BULK]).toBeUndefined()
    expect(fairShare.snapshot('normal').waiting).toEqual([QUIET])
  })
})

describe('starvation', () => {
  it('admits a job that has been deferred too many times', () => {
    // A queue that is perfectly fair and never runs your job is worse than one
    // that is unfair. The bound makes the worst case a delay, not a hang.
    fairShare.recordDeferred(QUIET)
    start(BULK, 500)
    expect(fairShare.admit(BULK, { deferrals: 19 }).allowed).toBe(false)
    const aged = fairShare.admit(BULK, { deferrals: 20 })
    expect(aged.allowed).toBe(true)
    expect(aged.aged).toBe(true)
  })

  it('honours a configured deferral bound', () => {
    process.env.FAIR_SHARE_MAX_DEFERRALS = '2'
    fairShare.recordDeferred(QUIET)
    start(BULK, 500)
    expect(fairShare.admit(BULK, { deferrals: 1 }).allowed).toBe(false)
    expect(fairShare.admit(BULK, { deferrals: 2 }).allowed).toBe(true)
  })
})

describe('the window', () => {
  it('forgets a burst once it has rolled past', () => {
    process.env.FAIR_SHARE_WINDOW_MS = '6000'
    const now = Date.now()
    const spy = jest.spyOn(Date, 'now')

    spy.mockReturnValue(now)
    start(BULK, 50)
    fairShare.recordDeferred(QUIET)
    expect(fairShare.admit(BULK).allowed).toBe(false)

    // A full window later BULK's burst is history — and so is QUIET's wait,
    // so there is nothing to be fair about either way.
    spy.mockReturnValue(now + 7000)
    expect(fairShare.snapshot().admitted[BULK]).toBe(0)
    spy.mockRestore()
  })
})

describe('the switch', () => {
  it('is inert when disabled, so a caller can consult it unconditionally', () => {
    process.env.DISABLE_FAIR_SHARE = 'true'
    fairShare.recordDeferred(QUIET)
    start(BULK, 500)
    expect(fairShare.admit(BULK).allowed).toBe(true)
    expect(fairShare.enabled()).toBe(false)
  })

  it('admits anything it cannot attribute to a workflow', () => {
    expect(fairShare.admit(null).allowed).toBe(true)
    expect(fairShare.admit(undefined).allowed).toBe(true)
  })
})
