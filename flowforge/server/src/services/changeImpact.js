// What does this change *mean*?
//
// A graph diff shows JSON. [`graphDiff.js`](./graphDiff.js) can tell you an
// edge was removed and [`backtest.js`](./backtest.js) can replay last week's
// traffic against the candidate and tell you what the outputs did. Neither
// answers the question a promotion review actually asks, which is what the edit
// *does to the properties somebody was relying on*.
//
// The answer matters most where it is least visible. Deleting one edge and
// wiring a trigger straight at the node behind it is a **one-line diff** that
// removes an approval from a payment path. Every node still lints. Every type
// still checks. Nothing is unreachable. And the effect report's dominance
// analysis has known how to catch it since the day it was written — the only
// thing missing was somebody running it twice and subtracting.
//
// So: run every static analysis over both graphs and report the **difference in
// their verdicts**.
//
// ---
//
// ## Only what changed
//
// The discipline this lives or dies by: a property that was already broken is
// **not a finding of this change**. A candidate whose predecessor already had an
// ungated charge should report nothing about it, because a review that relists
// every pre-existing problem on every edit is a review nobody reads twice —
// and the one new line gets lost among the forty old ones.
//
// This is the same rule [mutation scoring](./mutationCheck.js) applies when it
// credits a mutant only with the errors its mutation introduced, and it is the
// same reason: a score built on inherited failures measures the wrong thing.
//
// `resolved` is reported too, and not out of politeness. An edit that removes a
// hazard is exactly as much a semantic change as one that adds it, and a
// reviewer told only about the bad half cannot tell a refactor from a
// regression.
//
// ## Identity, and where it breaks
//
// Two findings are "the same finding" when they share an area, a code, and a
// subject — almost always a node id. That works because a node keeps its id
// across an edit.
//
// It stops working when somebody deletes a node and draws a new one in its
// place: the ids differ, so one finding reads as resolved and another as
// introduced, when a person would call it neither. The report does not pretend
// otherwise. `nodes.added` and `nodes.removed` are published beside the
// findings, so a reviewer looking at a suspicious pair can see that the graph
// gained and lost a node and read the two lines as one.
//
// Guessing at the correspondence — matching on label, or position, or shape —
// would be inventing an identity the graph does not carry, and getting it wrong
// silently is worse than the counting problem it fixes.

const { analyzeEffects } = require('./effects')
const { reachableEffects } = require('./reach')
const { analyzeRepeats } = require('./repeats')
const { verifyGuarantees } = require('./guarantees')
const { pathIssues } = require('./pathConstraints')
const { analyzeConvergence } = require('./convergence')
const { lintGraph } = require('./workflowLinter')

// How loudly each kind of change is reported, and the order a reviewer should
// read them in.
//
// `ungated-effect` leads, and it leads over a broken guarantee on purpose. A
// broken guarantee is already refused at deploy — somebody declared the
// property, so the gate exists and this is a second opinion. An effect that
// quietly loses its gate is legal, deployable, and nobody declared anything
// about it, which makes this the only place it is ever going to be said.
const SEVERITY = {
  'ungated-effect': 100,
  'guarantee-broken': 90,
  'lint-error': 80,
  'unsafe-repeat': 70,
  'new-effect': 60,
  'dead-branch': 50,
  'dynamic-target': 40,
  'unresolved-tie': 30,
  'lint-warning': 20,
}

// A finding that stops a deploy through some *other* gate, versus one that is
// perfectly legal and worth a person's attention. The distinction is the point
// of the report: the first list is a duplicate of checks that already run, and
// the second is what nothing else says out loud.
const BLOCKING = new Set(['guarantee-broken', 'lint-error'])

const keyOf = (f) => `${f.code}:${f.subject}`

// Effects, keyed by the node that performs them. Uses the transitive walk when
// a resolver is given, so adding a sub-workflow call reports what the call
// reaches rather than that a call appeared.
function effectFindings(workflow, resolve) {
  const report = resolve
    ? reachableEffects(workflow, resolve)
    : analyzeEffects(workflow.graph)
  if (!report.available) return new Map()

  const out = new Map()
  for (const e of report.effects) {
    const subject = `${e.workflowId || workflow.id}:${e.nodeId}`
    out.set(`effect:${subject}`, {
      subject,
      label: e.label,
      nodeId: e.nodeId,
      kind: e.kind,
      target: e.target,
      always: Boolean(e.always),
      via: (e.via || []).map((v) => v.name),
    })
  }
  return out
}

function repeatFindings(workflow, resolve, recoveryPolicy) {
  const report = analyzeRepeats(workflow, resolve, { recoveryPolicy })
  if (!report.available) return new Map()
  const out = new Map()
  for (const s of report.steps) {
    out.set(`repeat:${s.nodeId}`, { subject: s.nodeId, label: s.label, verdict: s.verdict, why: s.why })
  }
  return out
}

function guaranteeFindings(graph, declarations) {
  const report = verifyGuarantees(graph, declarations)
  const out = new Map()
  for (const g of report.results || []) {
    out.set(`guarantee:${g.kind}:${g.node}:${g.other}`, {
      subject: `${g.kind}:${g.node}:${g.other}`,
      statement: g.statement,
      status: g.status,
    })
  }
  return out
}

function lintFindings(graph, options) {
  const out = new Map()
  for (const issue of lintGraph(graph, options)) {
    // The message is part of the key: two `missing-config` errors on one node
    // are two problems, and collapsing them would hide the second one being
    // fixed.
    const subject = `${issue.nodeId || 'graph'}:${issue.code}:${issue.message}`
    out.set(`lint:${subject}`, { subject, severity: issue.severity, message: issue.message, nodeId: issue.nodeId })
  }
  return out
}

function pathFindings(graph) {
  const out = new Map()
  for (const issue of pathIssues(graph)) {
    const subject = `${issue.nodeId || 'graph'}:${issue.code}`
    out.set(`path:${subject}`, { subject, message: issue.message, nodeId: issue.nodeId })
  }
  return out
}

function convergenceFindings(graph) {
  const report = analyzeConvergence(graph)
  if (!report.available) return new Map()
  const out = new Map()
  for (const join of report.joins || []) {
    for (const c of join.collisions || []) {
      if (c.resolution !== 'tie-break') continue
      const subject = `${join.nodeId}:${c.field}`
      out.set(`converge:${subject}`, { subject, field: c.field, nodeId: join.nodeId, label: join.label })
    }
  }
  return out
}

const finding = (code, summary, detail, extra = {}) => ({
  code,
  severity: SEVERITY[code] ?? 0,
  blocking: BLOCKING.has(code),
  summary,
  detail,
  ...extra,
})

// What a change did to the outside world's exposure.
function diffEffects(before, after, findings) {
  for (const [key, now] of after) {
    const was = before.get(key)
    if (!was) {
      findings.push(
        finding('new-effect', `${now.label} is new`, whereDetail(now), {
          nodeId: now.nodeId,
          subject: now.subject,
        })
      )
      continue
    }
    // The finding the whole report exists for: an effect that had a gate and
    // does not now. Not a new effect, not a lint error, not a type change —
    // the same node, doing the same thing, with nothing in front of it.
    if (was.always === false && now.always === true) {
      findings.push(
        finding(
          'ungated-effect',
          `${now.label} now runs on every run`,
          `It was gated before this change; nothing in the graph gates it now.`,
          { nodeId: now.nodeId, subject: now.subject }
        )
      )
    }
    if (was.target && !now.target) {
      findings.push(
        finding(
          'dynamic-target',
          `${now.label}'s destination is no longer fixed by the graph`,
          `It went to ${was.target}; where it goes now depends on the data.`,
          { nodeId: now.nodeId, subject: now.subject }
        )
      )
    }
  }
}

const whereDetail = (e) =>
  e.via.length > 0
    ? `A ${e.kind} reached through ${e.via.join(' → ')}${e.target ? `, to ${e.target}` : ''}.`
    : `A ${e.kind}${e.target ? ` to ${e.target}` : ''}.`

function diffRepeats(before, after, findings) {
  const SAFE = new Set(['safe', 'guarded'])
  for (const [key, now] of after) {
    const was = before.get(key)
    if (!was || was.verdict === now.verdict) continue
    if (SAFE.has(was.verdict) && !SAFE.has(now.verdict)) {
      findings.push(
        finding('unsafe-repeat', `${now.label} is no longer safe to repeat`, now.why, {
          nodeId: now.subject,
          subject: now.subject,
        })
      )
    }
  }
}

function diffGuarantees(before, after, findings) {
  for (const [key, now] of after) {
    const was = before.get(key)
    // A guarantee that was already failing is not this change's doing, and a
    // newly *declared* one that fails is a problem with the declaration rather
    // than with the edit.
    if (!was || was.status !== 'holds' || now.status === 'holds') continue
    findings.push(
      finding(
        'guarantee-broken',
        `A declared guarantee no longer holds`,
        `${now.statement} — ${now.status === 'unknown' ? 'it can no longer be checked' : 'it is broken by this change'}.`,
        { subject: now.subject }
      )
    )
  }
}

function diffLint(before, after, findings) {
  for (const [key, now] of after) {
    if (before.has(key)) continue
    if (now.severity !== 'error' && now.severity !== 'warning') continue
    findings.push(
      finding(
        now.severity === 'error' ? 'lint-error' : 'lint-warning',
        now.message,
        `Introduced by this change.`,
        { nodeId: now.nodeId, subject: now.subject }
      )
    )
  }
}

function diffPaths(before, after, findings) {
  for (const [key, now] of after) {
    if (before.has(key)) continue
    findings.push(
      finding('dead-branch', now.message, 'No input can take this branch.', {
        nodeId: now.nodeId,
        subject: now.subject,
      })
    )
  }
}

function diffConvergence(before, after, findings) {
  for (const [key, now] of after) {
    if (before.has(key)) continue
    findings.push(
      finding(
        'unresolved-tie',
        `"${now.field}" arrives at ${now.label} from branches nothing orders`,
        'Two contributors at the same depth; the winner is decided by a canonical sort.',
        { nodeId: now.nodeId, subject: now.subject }
      )
    )
  }
}

// Everything the candidate resolved. Reported because a reviewer told only
// about the bad half cannot tell a refactor from a regression.
function resolvedFindings(beforeMaps, afterMaps) {
  const out = []
  const add = (code, summary, subject) => out.push({ code, summary, subject })

  for (const [key, was] of beforeMaps.effects) {
    const now = afterMaps.effects.get(key)
    if (now && was.always === true && now.always === false) {
      add('effect-gated', `${now.label} is now gated`, now.subject)
    }
  }
  const SAFE = new Set(['safe', 'guarded'])
  for (const [key, was] of beforeMaps.repeats) {
    const now = afterMaps.repeats.get(key)
    if (now && !SAFE.has(was.verdict) && SAFE.has(now.verdict)) {
      add('repeat-guarded', `${now.label} is now safe to repeat`, now.subject)
    }
  }
  for (const [key, was] of beforeMaps.lint) {
    if (!afterMaps.lint.has(key) && (was.severity === 'error' || was.severity === 'warning')) {
      add('lint-fixed', was.message, was.subject)
    }
  }
  for (const [key, was] of beforeMaps.paths) {
    if (!afterMaps.paths.has(key)) add('branch-reachable', was.message, was.subject)
  }
  return out
}

const nodeIds = (graph) => new Set((graph?.nodes || []).map((n) => n.id))

// What a candidate definition does to the properties somebody was relying on.
//
// `before` and `after` are `{ id, name, graph }`. `resolve(id)` is optional and
// expands sub-workflow calls in both, so a change that adds a call reports what
// the call reaches rather than that a call appeared.
function analyzeImpact(before, after, { guarantees = null, resolve = null, recoveryPolicy = 'safe', lintOptions = {} } = {}) {
  if (!before?.graph?.nodes || !after?.graph?.nodes) {
    return { available: false, reason: 'empty' }
  }

  const beforeMaps = {
    effects: effectFindings(before, resolve),
    repeats: repeatFindings(before, resolve, recoveryPolicy),
    guarantees: guaranteeFindings(before.graph, guarantees),
    lint: lintFindings(before.graph, lintOptions),
    paths: pathFindings(before.graph),
    converge: convergenceFindings(before.graph),
  }
  const afterMaps = {
    effects: effectFindings(after, resolve),
    repeats: repeatFindings(after, resolve, recoveryPolicy),
    guarantees: guaranteeFindings(after.graph, guarantees),
    lint: lintFindings(after.graph, lintOptions),
    paths: pathFindings(after.graph),
    converge: convergenceFindings(after.graph),
  }

  const findings = []
  diffEffects(beforeMaps.effects, afterMaps.effects, findings)
  diffRepeats(beforeMaps.repeats, afterMaps.repeats, findings)
  diffGuarantees(beforeMaps.guarantees, afterMaps.guarantees, findings)
  diffLint(beforeMaps.lint, afterMaps.lint, findings)
  diffPaths(beforeMaps.paths, afterMaps.paths, findings)
  diffConvergence(beforeMaps.converge, afterMaps.converge, findings)

  findings.sort((a, b) => b.severity - a.severity || String(a.summary).localeCompare(String(b.summary)))
  const resolvedList = resolvedFindings(beforeMaps, afterMaps)

  const wasIds = nodeIds(before.graph)
  const nowIds = nodeIds(after.graph)
  const added = [...nowIds].filter((id) => !wasIds.has(id))
  const removed = [...wasIds].filter((id) => !nowIds.has(id))

  const blocking = findings.filter((f) => f.blocking)
  return {
    available: true,
    workflowId: after.id,
    findings,
    resolved: resolvedList,
    // Published beside the findings so a reviewer can read a suspicious
    // resolved/introduced pair as one node having been replaced, which is
    // something the ids cannot tell them.
    nodes: { added, removed },
    summary: {
      introduced: findings.length,
      resolved: resolvedList.length,
      blocking: blocking.length,
      // `review` is the tier this report exists for: legal, deployable, and
      // nothing else in the product says it out loud.
      review: findings.length - blocking.length,
      verdict: blocking.length > 0 ? 'blocked' : findings.length > 0 ? 'review' : 'clear',
    },
  }
}

module.exports = { analyzeImpact, SEVERITY, BLOCKING, keyOf }
