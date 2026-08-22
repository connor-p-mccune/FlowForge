// Who may settle an approval gate, and when it is settled.
//
// The gate began as "the run pauses until *a* workspace member responds", which
// is the right default and the wrong one for the runs anybody actually puts a
// gate in front of. A refund over ten thousand, a production database
// migration, a payout — those are the cases somebody drops an approval node
// into, and for all of them the interesting requirement is not that a human
// looked. It is that **the right humans**, **enough of them**, and **not the
// person who asked**.
//
// Three declarations, and each of them exists because "whoever gets there
// first" is a genuine hole rather than a missing nicety:
//
//   * **Quorum** — N distinct approvals, not one. Four-eyes is the standard
//     control for a change that cannot be undone by the person who made it.
//   * **Required role** — the gate can demand a workspace *owner*. A control
//     any member can wave through is a control the org does not have.
//   * **Separation of duties** — whoever triggered the run may not approve it.
//     The oldest control there is, and the one a self-service tool most needs:
//     without it, the person who wants the refund is one click away from
//     granting it themselves.
//
// This module is the pure decision core: parse the declaration, judge one
// person's eligibility, and decide from a set of recorded responses whether the
// gate has settled. No database — `services/approvals.js` owns the rows and the
// races, and the node runner owns the wait.

const MAX_QUORUM = 20
const ROLES = ['any', 'owner']

// Read the gate off a node's config, clamping rather than rejecting — the same
// posture the rest of the approval config takes, because an invalid value must
// not fail a run that would otherwise work. The linter is where a typo is
// reported; here it degrades to the safe reading.
//
// "Safe" is the load-bearing word for `separationOfDuties`: an unparseable
// value resolves to *false* (no exclusion) rather than true, because a gate
// that silently excluded people the author did not mean to exclude would
// deadlock a run, while one that silently included them is exactly the
// behaviour every gate had before this existed.
function parseGate(config = {}) {
  const raw = Number(config.quorum)
  const quorum = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_QUORUM) : 1
  const requiredRole = ROLES.includes(config.approverRole) ? config.approverRole : 'any'
  return {
    quorum,
    requiredRole,
    separationOfDuties: config.separationOfDuties === true || config.separationOfDuties === 'true',
  }
}

// Is this gate anything other than the historical default? Used to keep the
// stored row, the published event and the UI silent about quorum on the
// overwhelming majority of approvals, which have none.
function isDefaultGate(gate) {
  return gate.quorum === 1 && gate.requiredRole === 'any' && !gate.separationOfDuties
}

// May `responder` settle this gate?
//
//   gate.requiredRole   'any' | 'owner'
//   excludedUserId      the run's triggering user, when separation of duties
//                       is on; null otherwise
//   responder           { userId, role }  — role from workspace_members
//
// Returns `{ allowed }` or `{ allowed: false, reason }`. The reason is
// user-facing: "you can't approve this" without saying why is the kind of
// message that generates a support ticket.
function judgeResponder(gate, { userId, role }, excludedUserId) {
  if (gate.requiredRole === 'owner' && role !== 'owner') {
    return { allowed: false, reason: 'role', message: 'This approval requires a workspace owner' }
  }
  if (excludedUserId && excludedUserId === userId) {
    return {
      allowed: false,
      reason: 'separation-of-duties',
      message: 'You started this run, so you cannot approve it',
    }
  }
  return { allowed: true }
}

// The gate's verdict given every response recorded so far.
//
//   responses  [{ userId, decision: 'approve' | 'reject' }]
//
// Two rules, and the first is the one worth arguing about:
//
//   **A single rejection settles the gate.** Not a quorum of rejections. A
//   quorum of approvals means "enough people agree this is safe to do"; one
//   person saying it is not means it is not, and requiring N objectors would
//   mean a lone reviewer who spots the problem cannot stop it. Change-approval
//   boards work the same way, for the same reason.
//
//   **A person counts once.** Deduplicated here as well as by a unique index
//   on the table, because a quorum somebody can satisfy alone is not a quorum —
//   and this function is also called on a set of rows loaded before the insert
//   that would have collided.
function verdict(gate, responses = []) {
  const seen = new Set()
  let approvals = 0
  for (const response of responses) {
    if (response.decision === 'reject') {
      return { settled: true, status: 'rejected', approvals, needed: gate.quorum }
    }
    const key = response.userId ?? Symbol('anonymous')
    if (seen.has(key)) continue
    seen.add(key)
    if (response.decision === 'approve') approvals += 1
  }
  if (approvals >= gate.quorum) {
    return { settled: true, status: 'approved', approvals, needed: gate.quorum }
  }
  return { settled: false, status: 'pending', approvals, needed: gate.quorum }
}

// A one-line description of the gate, for the notification and the panel.
// Empty for the default gate — a message that says "1 approval required" on
// every ordinary approval is noise that trains people to skip the line that
// will one day say something.
function describeGate(gate) {
  if (isDefaultGate(gate)) return null
  const parts = []
  if (gate.quorum > 1) parts.push(`${gate.quorum} approvals`)
  if (gate.requiredRole === 'owner') parts.push('from workspace owners')
  if (gate.separationOfDuties) parts.push('not including whoever started the run')
  return parts.join(', ')
}

module.exports = {
  MAX_QUORUM,
  ROLES,
  parseGate,
  isDefaultGate,
  judgeResponder,
  verdict,
  describeGate,
}
