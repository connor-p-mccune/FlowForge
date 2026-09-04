// What does this change *mean*?
//
// A graph diff shows JSON. This runs every static analysis over both graphs and
// reports the difference in their verdicts — and the discipline it lives or
// dies by is that a property which was *already* broken is not a finding of
// this change.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { analyzeImpact } = require('../services/changeImpact')

const n = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const e = (source, target, sourceHandle) => ({
  id: `e-${source}-${target}${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

const wf = (nodes, edges) => ({ id: 'wf1', name: 'Orders', graph: { nodes, edges } })

// A payment behind an approval — the shape the report exists for.
const GATED_NODES = [
  n('t', 'trigger-webhook', {}, 'Start'),
  n('a', 'approval', {}, 'Approve'),
  n('c', 'action-http', { method: 'POST', url: 'https://api.acme.com/charge' }, 'Charge card'),
]
const gated = () => wf(GATED_NODES, [e('t', 'a'), e('a', 'c', 'true')])
// The one-line diff: a second trigger wired straight at the node behind it.
const ungated = () => wf(GATED_NODES, [e('t', 'a'), e('a', 'c', 'true'), e('t', 'c')])

const codes = (report) => report.findings.map((f) => f.code)
const find = (report, code) => report.findings.find((f) => f.code === code)

describe('changeImpact — the one-line diff', () => {
  it('reports an effect that lost its gate', () => {
    // Every node still lints, every type still checks, nothing is unreachable,
    // and a payment stopped needing an approval.
    const report = analyzeImpact(gated(), ungated())
    expect(find(report, 'ungated-effect')).toMatchObject({
      nodeId: 'c',
      summary: 'Charge card now runs on every run',
    })
  })

  it('leads with it, above the guarantee that also broke', () => {
    // The broken guarantee is already refused at deploy — somebody declared
    // the property. The ungating is legal, deployable, and nothing else in the
    // product says it out loud.
    const report = analyzeImpact(gated(), ungated(), {
      guarantees: [{ kind: 'requires', node: 'c', other: 'a' }],
    })
    expect(codes(report)[0]).toBe('ungated-effect')
    expect(codes(report)).toContain('guarantee-broken')
  })

  it('separates what another gate already refuses from what nothing says', () => {
    const report = analyzeImpact(gated(), ungated(), {
      guarantees: [{ kind: 'requires', node: 'c', other: 'a' }],
    })
    expect(report.summary).toMatchObject({ blocking: 1, review: 1, verdict: 'blocked' })
    expect(find(report, 'ungated-effect').blocking).toBe(false)
    expect(find(report, 'guarantee-broken').blocking).toBe(true)
  })

  it('says review, not blocked, when the change is merely enormous', () => {
    // Nobody declared a guarantee, so nothing refuses this deploy. That is
    // exactly the case worth reporting.
    const report = analyzeImpact(gated(), ungated())
    expect(report.summary.verdict).toBe('review')
    expect(report.summary.blocking).toBe(0)
  })
})

describe('changeImpact — only what changed', () => {
  it('says nothing about a problem the candidate inherited', () => {
    // A review that relists every pre-existing problem on every edit is a
    // review nobody reads twice, and the one new line gets lost.
    const before = ungated()
    const after = wf(
      [...GATED_NODES, n('log', 'output-log', {}, 'Log')],
      [...before.graph.edges, e('c', 'log')]
    )
    const report = analyzeImpact(before, after)
    expect(codes(report)).not.toContain('ungated-effect')
  })

  it('reports nothing at all when nothing changed', () => {
    const report = analyzeImpact(gated(), gated())
    expect(report.findings).toEqual([])
    expect(report.summary.verdict).toBe('clear')
  })

  it('does not blame a change for a guarantee that was already failing', () => {
    const report = analyzeImpact(ungated(), ungated(), {
      guarantees: [{ kind: 'requires', node: 'c', other: 'a' }],
    })
    expect(codes(report)).not.toContain('guarantee-broken')
  })

  it('does not blame a change for a guarantee somebody just declared', () => {
    // A newly declared guarantee that fails is a problem with the declaration,
    // not with the edit — and this report is about the edit.
    const report = analyzeImpact(ungated(), ungated(), {
      guarantees: [{ kind: 'requires', node: 'c', other: 'a' }],
    })
    expect(report.summary.introduced).toBe(0)
  })
})

describe('changeImpact — what the change fixed', () => {
  it('reports an effect that gained a gate', () => {
    // A reviewer told only about the bad half cannot tell a refactor from a
    // regression.
    const report = analyzeImpact(ungated(), gated())
    expect(report.resolved.map((r) => r.code)).toContain('effect-gated')
    expect(report.findings).toEqual([])
  })

  it('reports a step that became safe to repeat', () => {
    const before = wf(
      [n('t', 'trigger-webhook'), n('c', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge')],
      [e('t', 'c')]
    )
    const after = wf(
      [
        n('t', 'trigger-webhook'),
        n('c', 'action-http', { method: 'POST', url: 'https://x/y', idempotent: true }, 'Charge'),
      ],
      [e('t', 'c')]
    )
    const report = analyzeImpact(before, after)
    expect(report.resolved.map((r) => r.code)).toContain('repeat-guarded')
  })

  it('counts the two halves apart', () => {
    const report = analyzeImpact(ungated(), gated())
    expect(report.summary).toMatchObject({ introduced: 0, resolved: 1, verdict: 'clear' })
  })
})

describe('changeImpact — the other analyses', () => {
  it('reports a step that stopped being safe to repeat', () => {
    const before = wf(
      [n('t', 'trigger-webhook'), n('c', 'action-http', { method: 'GET', url: 'https://x/y' }, 'Fetch')],
      [e('t', 'c')]
    )
    const after = wf(
      [n('t', 'trigger-webhook'), n('c', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Fetch')],
      [e('t', 'c')]
    )
    expect(codes(analyzeImpact(before, after))).toContain('unsafe-repeat')
  })

  it('reports a destination the graph stopped determining', () => {
    const before = wf(
      [n('t', 'trigger-webhook'), n('c', 'action-http', { method: 'GET', url: 'https://api.acme.com/x' }, 'Fetch')],
      [e('t', 'c')]
    )
    const after = wf(
      [n('t', 'trigger-webhook'), n('c', 'action-http', { method: 'GET', url: '{{trigger.url}}' }, 'Fetch')],
      [e('t', 'c')]
    )
    const finding = find(analyzeImpact(before, after), 'dynamic-target')
    expect(finding.detail).toMatch(/api\.acme\.com/)
  })

  it('reports an effect the change added', () => {
    const before = wf([n('t', 'trigger-webhook')], [])
    const after = wf(
      [n('t', 'trigger-webhook'), n('s', 'action-slack', { webhookUrl: 'https://hooks.slack.com/x', message: 'hi' }, 'Post')],
      [e('t', 's')]
    )
    expect(codes(analyzeImpact(before, after))).toContain('new-effect')
  })

  it('reports a lint error the change introduced, and not the ones it did not', () => {
    const before = wf(
      [n('t', 'trigger-webhook'), n('h', 'action-http', { method: 'GET', url: 'https://x/y' }, 'Fetch')],
      [e('t', 'h')]
    )
    const after = wf(
      [n('t', 'trigger-webhook'), n('h', 'action-http', { method: 'GET' }, 'Fetch')],
      [e('t', 'h')]
    )
    const report = analyzeImpact(before, after)
    expect(codes(report)).toContain('lint-error')
    expect(report.summary.blocking).toBeGreaterThan(0)
  })

  it('reports a lint error the change fixed', () => {
    const broken = wf(
      [n('t', 'trigger-webhook'), n('h', 'action-http', { method: 'GET' }, 'Fetch')],
      [e('t', 'h')]
    )
    const fixed = wf(
      [n('t', 'trigger-webhook'), n('h', 'action-http', { method: 'GET', url: 'https://x/y' }, 'Fetch')],
      [e('t', 'h')]
    )
    expect(analyzeImpact(broken, fixed).resolved.map((r) => r.code)).toContain('lint-fixed')
  })
})

describe('changeImpact — identity, and where it breaks', () => {
  it('publishes the nodes that came and went', () => {
    // Two findings on two different ids may be one node having been replaced,
    // and the ids cannot say. This is what lets a reviewer read them as one.
    const before = wf(
      [n('t', 'trigger-webhook'), n('old', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge')],
      [e('t', 'old')]
    )
    const after = wf(
      [n('t', 'trigger-webhook'), n('new', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge')],
      [e('t', 'new')]
    )
    const report = analyzeImpact(before, after)
    expect(report.nodes).toEqual({ added: ['new'], removed: ['old'] })
  })

  it('does not guess that a replaced node is the same node', () => {
    // Matching on label or position would be inventing an identity the graph
    // does not carry, and getting it wrong silently is worse than the counting
    // problem it fixes.
    const before = wf(
      [n('t', 'trigger-webhook'), n('a', 'approval', {}, 'Approve'), n('old', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge')],
      [e('t', 'a'), e('a', 'old', 'true')]
    )
    const after = wf(
      [n('t', 'trigger-webhook'), n('a', 'approval', {}, 'Approve'), n('new', 'action-http', { method: 'POST', url: 'https://x/y' }, 'Charge')],
      [e('t', 'a'), e('a', 'new', 'true')]
    )
    const report = analyzeImpact(before, after)
    // Reported as a new effect, not as an ungating — because it is a node the
    // report has never seen.
    expect(codes(report)).toContain('new-effect')
    expect(codes(report)).not.toContain('ungated-effect')
  })
})

describe('changeImpact — across the sub-workflow boundary', () => {
  const callee = (nodes, edges) => ({ id: 'wf2', name: 'Fulfilment', graph: { nodes, edges } })

  it('reports what a new call reaches, not that a call appeared', () => {
    const resolve = () =>
      callee(
        [n('ct', 'trigger-manual'), n('charge', 'action-http', { method: 'POST', url: 'https://api.acme.com/charge' }, 'Charge card')],
        [e('ct', 'charge')]
      )
    const before = wf([n('t', 'trigger-webhook')], [])
    const after = wf(
      [n('t', 'trigger-webhook'), n('call', 'sub-workflow', { workflowId: 'wf2' }, 'Fulfil order')],
      [e('t', 'call')]
    )
    const report = analyzeImpact(before, after, { resolve })
    const added = find(report, 'new-effect')
    expect(added.summary).toBe('Charge card is new')
    expect(added.detail).toMatch(/reached through Fulfilment/)
  })

  it('falls back to the graph in front of it when it cannot read a callee', () => {
    const before = wf([n('t', 'trigger-webhook')], [])
    const after = wf(
      [n('t', 'trigger-webhook'), n('call', 'sub-workflow', { workflowId: 'wf2' }, 'Fulfil order')],
      [e('t', 'call')]
    )
    const report = analyzeImpact(before, after, { resolve: () => null })
    expect(find(report, 'new-effect').summary).toBe('Fulfil order is new')
  })
})

describe('changeImpact — what it refuses', () => {
  it('will not compare against a graph it does not have', () => {
    expect(analyzeImpact(null, gated())).toEqual({ available: false, reason: 'empty' })
    expect(analyzeImpact(gated(), { id: 'x' })).toEqual({ available: false, reason: 'empty' })
  })

  it('orders findings by what a reviewer should read first', () => {
    const report = analyzeImpact(gated(), ungated(), {
      guarantees: [{ kind: 'requires', node: 'c', other: 'a' }],
    })
    const severities = report.findings.map((f) => f.severity)
    expect([...severities].sort((a, b) => b - a)).toEqual(severities)
  })
})
