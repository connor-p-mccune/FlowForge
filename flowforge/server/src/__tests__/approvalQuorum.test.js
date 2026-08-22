// The approval gate's decision core: who may settle it, and when it is settled.

const {
  parseGate,
  isDefaultGate,
  judgeResponder,
  verdict,
  describeGate,
  MAX_QUORUM,
} = require('../services/approvalQuorum')

const approve = (userId) => ({ userId, decision: 'approve' })
const reject = (userId) => ({ userId, decision: 'reject' })

describe('parseGate', () => {
  it('defaults to the behaviour every approval had before it existed', () => {
    expect(parseGate({})).toEqual({ quorum: 1, requiredRole: 'any', separationOfDuties: false })
    expect(isDefaultGate(parseGate({}))).toBe(true)
  })

  it('reads a declared quorum, role, and separation of duties', () => {
    const gate = parseGate({ quorum: 3, approverRole: 'owner', separationOfDuties: true })
    expect(gate).toEqual({ quorum: 3, requiredRole: 'owner', separationOfDuties: true })
    expect(isDefaultGate(gate)).toBe(false)
  })

  it('accepts the string "true" a form control produces', () => {
    expect(parseGate({ separationOfDuties: 'true' }).separationOfDuties).toBe(true)
  })

  it('clamps rather than rejects, so a typo cannot fail a run', () => {
    expect(parseGate({ quorum: 0 }).quorum).toBe(1)
    expect(parseGate({ quorum: -4 }).quorum).toBe(1)
    expect(parseGate({ quorum: 'lots' }).quorum).toBe(1)
    expect(parseGate({ quorum: 2.7 }).quorum).toBe(2)
    expect(parseGate({ quorum: 5000 }).quorum).toBe(MAX_QUORUM)
    expect(parseGate({ approverRole: 'admin' }).requiredRole).toBe('any')
  })

  it('resolves an unparseable separation-of-duties to *off*', () => {
    // The direction matters. A gate that silently excluded people the author
    // did not mean to exclude would deadlock a run; one that silently included
    // them is exactly what every gate did before this existed.
    expect(parseGate({ separationOfDuties: 'yes' }).separationOfDuties).toBe(false)
    expect(parseGate({ separationOfDuties: 1 }).separationOfDuties).toBe(false)
  })
})

describe('judgeResponder', () => {
  const owner = { userId: 'u-owner', role: 'owner' }
  const member = { userId: 'u-member', role: 'member' }

  it('lets any member settle an ordinary gate', () => {
    expect(judgeResponder(parseGate({}), member, null).allowed).toBe(true)
  })

  it('refuses a member when the gate requires an owner', () => {
    const gate = parseGate({ approverRole: 'owner' })
    const result = judgeResponder(gate, member, null)
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('role')
    expect(result.message).toMatch(/workspace owner/)
  })

  it('lets an owner settle an owner-only gate', () => {
    expect(judgeResponder(parseGate({ approverRole: 'owner' }), owner, null).allowed).toBe(true)
  })

  it('refuses whoever started the run under separation of duties', () => {
    const gate = parseGate({ separationOfDuties: true })
    const result = judgeResponder(gate, member, 'u-member')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('separation-of-duties')
    expect(result.message).toMatch(/you cannot approve it/i)
  })

  it('excludes nobody when the run has no triggering user', () => {
    // A webhook or schedule run has no `triggered_by`, so there is nobody to
    // exclude. The control does not silently become something else.
    expect(judgeResponder(parseGate({ separationOfDuties: true }), member, null).allowed).toBe(true)
  })

  it('still refuses an owner who started the run', () => {
    // Separation of duties is about the *role in this run*, not seniority.
    const gate = parseGate({ approverRole: 'owner', separationOfDuties: true })
    expect(judgeResponder(gate, owner, 'u-owner').allowed).toBe(false)
  })
})

describe('verdict', () => {
  const one = parseGate({})
  const two = parseGate({ quorum: 2 })
  const three = parseGate({ quorum: 3 })

  it('settles on the first approval when no quorum is declared', () => {
    expect(verdict(one, [approve('a')])).toMatchObject({ settled: true, status: 'approved' })
  })

  it('waits until the quorum is reached', () => {
    expect(verdict(two, [])).toMatchObject({ settled: false, approvals: 0, needed: 2 })
    expect(verdict(two, [approve('a')])).toMatchObject({ settled: false, approvals: 1, needed: 2 })
    expect(verdict(two, [approve('a'), approve('b')])).toMatchObject({ settled: true, status: 'approved' })
  })

  it('will not let one person satisfy a quorum alone', () => {
    // The whole point of four-eyes. Deduplicated here as well as by the unique
    // index, because this is also called on rows loaded before the insert that
    // would have collided.
    expect(verdict(two, [approve('a'), approve('a')])).toMatchObject({ settled: false, approvals: 1 })
    expect(verdict(three, [approve('a'), approve('a'), approve('a')])).toMatchObject({ settled: false })
  })

  it('settles rejected on a single objection, whatever the quorum', () => {
    // Not a quorum of rejections: a quorum of approvals means "enough people
    // agree this is safe", and one person saying it is not means it is not.
    // Requiring N objectors would mean a lone reviewer who spots the problem
    // cannot stop it.
    expect(verdict(three, [reject('a')])).toMatchObject({ settled: true, status: 'rejected' })
    expect(verdict(three, [approve('a'), approve('b'), reject('c')])).toMatchObject({
      settled: true,
      status: 'rejected',
    })
  })

  it('reports the approvals gathered before the rejection', () => {
    expect(verdict(three, [approve('a'), reject('b')]).approvals).toBe(1)
  })

  it('reports progress so a panel can render "1 of 3"', () => {
    expect(verdict(three, [approve('a')])).toEqual({
      settled: false,
      status: 'pending',
      approvals: 1,
      needed: 3,
    })
  })
})

describe('describeGate', () => {
  it('says nothing about an ordinary approval', () => {
    // A line reading "1 approval required" on every gate is noise that trains
    // people to skip the line that will one day say something.
    expect(describeGate(parseGate({}))).toBeNull()
  })

  it('names each declared requirement', () => {
    expect(describeGate(parseGate({ quorum: 2 }))).toBe('2 approvals')
    expect(describeGate(parseGate({ approverRole: 'owner' }))).toBe('from workspace owners')
    expect(describeGate(parseGate({ quorum: 2, approverRole: 'owner', separationOfDuties: true })))
      .toBe('2 approvals, from workspace owners, not including whoever started the run')
  })
})
