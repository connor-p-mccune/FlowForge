// Workflow guarantees. The tests are weighted towards the cases where a
// plausible-but-wrong implementation would report that an invariant *holds*,
// because that is the only failure mode that matters: a checker that misses a
// violation hands somebody a false assurance about a card charge, while one
// that over-reports merely annoys them.
//
// So the graphs below include the shapes that break the easy version — a
// branch that dangles instead of rejoining, a second trigger that reaches the
// same node around the gate, a compensating node that looks like a bypass and
// isn't, and an error branch, which is a decision the type-based models miss.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const {
  outcomeGroups,
  analyzeGraph,
  parseGuarantees,
  verifyGuarantees,
  guaranteeIssues,
} = require('../services/guarantees')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle) => ({
  id: `${source}-${target}-${sourceHandle || ''}`,
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
})

const http = (id, config = {}, label = id) =>
  node(id, 'action-http', { method: 'POST', url: 'https://api.example.com/x', ...config }, label)

// hook → approve → (true) charge, (false) reject-log
const approvalFlow = () => ({
  nodes: [
    node('hook', 'trigger-webhook', {}, 'Order webhook'),
    node('approve', 'approval', {}, 'Approve'),
    http('charge', {}, 'Charge card'),
    node('decline', 'output-log', {}, 'Log decline'),
  ],
  edges: [
    edge('hook', 'approve'),
    edge('approve', 'charge', 'true'),
    edge('approve', 'decline', 'false'),
  ],
})

const statuses = (graph, list) =>
  verifyGuarantees(graph, list).results.map((r) => `${r.kind}:${r.status}`)

describe('outcome groups', () => {
  it('splits the nodes that route, and leaves the rest whole', () => {
    expect(outcomeGroups(node('c', 'condition'))).toEqual([['true'], ['false']])
    expect(outcomeGroups(node('v', 'validate'))).toEqual([['valid'], ['invalid']])
    expect(outcomeGroups(node('h', 'action-http'))).toEqual([[null]])
  })

  it('reads a switch’s cases as outcomes, plus the reserved default', () => {
    const sw = node('s', 'switch', { cases: [{ label: 'gold' }, { label: 'silver' }] })
    expect(outcomeGroups(sw)).toEqual([['gold'], ['silver'], ['default']])
  })

  it('treats an error-branch policy as a two-way decision', () => {
    // The engine activates *either* the error handle or every ordinary edge,
    // never both — the same shape a condition has, which is why one check
    // covers it.
    expect(outcomeGroups(http('h', { onError: 'branch' }))).toEqual([['error'], [null]])
    // …but not on a node whose failure the engine already routes.
    expect(outcomeGroups(node('c', 'condition', { onError: 'branch' }))).toEqual([
      ['true'],
      ['false'],
    ])
  })

  it('drops the timed-out outcome when a callback is told to fail instead', () => {
    expect(outcomeGroups(node('w', 'wait-callback', { onTimeout: 'fail' }))).toEqual([['received']])
  })
})

describe('requires', () => {
  it('holds when the gate dominates the effect', () => {
    const list = [{ kind: 'requires', node: 'charge', other: 'approve' }]
    expect(statuses(approvalFlow(), list)).toEqual(['requires:holds'])
  })

  it('fails when a second trigger reaches the effect around the gate', () => {
    // The exact regression the feature exists for: somebody adds a manual
    // trigger for testing and wires it straight at the charge. Every node still
    // lints, every type still checks, and the approval is now optional.
    const graph = approvalFlow()
    graph.nodes.push(node('manual', 'trigger-manual', {}, 'Run by hand'))
    graph.edges.push(edge('manual', 'charge'))

    const report = verifyGuarantees(graph, [
      { kind: 'requires', node: 'charge', other: 'approve' },
    ])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].counterexample).toEqual(['manual', 'charge'])
    expect(report.results[0].message).toBe('Run by hand → Charge card reaches Charge card without Approve')
  })

  it('fails when an edge skips past the gate', () => {
    const graph = approvalFlow()
    graph.edges.push(edge('hook', 'charge'))
    const report = verifyGuarantees(graph, [
      { kind: 'requires', node: 'charge', other: 'approve' },
    ])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].counterexample).toEqual(['hook', 'charge'])
  })

  it('holds through a diamond that reconverges after the gate', () => {
    const graph = approvalFlow()
    graph.nodes.push(node('fanA', 'transform', {}, 'A'), node('fanB', 'transform', {}, 'B'))
    graph.edges = [
      edge('hook', 'approve'),
      edge('approve', 'fanA', 'true'),
      edge('approve', 'fanB', 'true'),
      edge('fanA', 'charge'),
      edge('fanB', 'charge'),
      edge('approve', 'decline', 'false'),
    ]
    expect(statuses(graph, [{ kind: 'requires', node: 'charge', other: 'approve' }])).toEqual([
      'requires:holds',
    ])
  })

  it('is not fooled by a compensating node wired at the effect', () => {
    // A compensation is stripped before the DAG is built, so it is not a path
    // to anything. Counting it as one would report a violation that cannot
    // happen — and the author would then "fix" a correct graph.
    const graph = approvalFlow()
    graph.nodes.push(node('refund', 'action-http', { compensates: 'charge', url: 'https://x/y' }, 'Refund'))
    graph.edges.push(edge('refund', 'charge'))
    expect(statuses(graph, [{ kind: 'requires', node: 'charge', other: 'approve' }])).toEqual([
      'requires:holds',
    ])
  })

  it('ignores sticky notes, which never execute', () => {
    const graph = approvalFlow()
    graph.nodes.push(node('n1', 'note', {}, 'TODO'))
    graph.edges.push(edge('n1', 'charge'))
    expect(statuses(graph, [{ kind: 'requires', node: 'charge', other: 'approve' }])).toEqual([
      'requires:holds',
    ])
  })

  it('sees an error branch as a real route to the effect', () => {
    // fetch fails → error branch → charge. The charge now runs on a path that
    // never touched the approval, and only a model that treats `onError:
    // branch` as routing can see it.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        http('fetch', { onError: 'branch' }, 'Fetch'),
        node('approve', 'approval', {}, 'Approve'),
        http('charge', {}, 'Charge'),
      ],
      edges: [
        edge('hook', 'fetch'),
        edge('fetch', 'approve'),
        edge('approve', 'charge', 'true'),
        edge('fetch', 'charge', 'error'),
      ],
    }
    const report = verifyGuarantees(graph, [
      { kind: 'requires', node: 'charge', other: 'approve' },
    ])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].counterexample).toEqual(['hook', 'fetch', 'charge'])
  })
})

describe('ensures', () => {
  const auditFlow = () => ({
    nodes: [
      node('hook', 'trigger-webhook', {}, 'Hook'),
      http('charge', {}, 'Charge'),
      node('audit', 'output-log', {}, 'Audit'),
    ],
    edges: [edge('hook', 'charge'), edge('charge', 'audit')],
  })

  it('holds when the follow-up is on every route out', () => {
    expect(statuses(auditFlow(), [{ kind: 'ensures', node: 'charge', other: 'audit' }])).toEqual([
      'ensures:holds',
    ])
  })

  it('fails when a branch after the effect ends the run instead', () => {
    const graph = auditFlow()
    graph.nodes.push(node('check', 'condition', {}, 'Big order?'))
    graph.edges = [
      edge('hook', 'charge'),
      edge('charge', 'check'),
      edge('check', 'audit', 'true'),
      // the false branch dangles — the run completes, unaudited
    ]
    const report = verifyGuarantees(graph, [{ kind: 'ensures', node: 'charge', other: 'audit' }])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].message).toContain('ends the run without reaching Audit')
  })

  it('holds again once both branches reach it', () => {
    const graph = auditFlow()
    graph.nodes.push(node('check', 'condition', {}, 'Big order?'))
    graph.edges = [
      edge('hook', 'charge'),
      edge('charge', 'check'),
      edge('check', 'audit', 'true'),
      edge('check', 'audit', 'false'),
    ]
    expect(statuses(graph, [{ kind: 'ensures', node: 'charge', other: 'audit' }])).toEqual([
      'ensures:holds',
    ])
  })
})

describe('exclusive', () => {
  it('holds for two effects on opposite sides of a condition', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('check', 'condition', {}, 'In stock?'),
        http('ship', {}, 'Ship'),
        http('refund', {}, 'Refund'),
      ],
      edges: [
        edge('hook', 'check'),
        edge('check', 'ship', 'true'),
        edge('check', 'refund', 'false'),
      ],
    }
    const report = verifyGuarantees(graph, [
      { kind: 'exclusive', node: 'ship', other: 'refund' },
    ])
    expect(report.results[0].status).toBe('holds')
    expect(report.results[0].evidence).toBe('In stock? decides between them')
  })

  it('fails when both sit under the same switch case', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('tier', 'switch', { cases: [{ label: 'gold' }, { label: 'silver' }] }, 'Tier'),
        http('ship', {}, 'Ship'),
        http('gift', {}, 'Gift'),
      ],
      edges: [
        edge('hook', 'tier'),
        edge('tier', 'ship', 'gold'),
        edge('tier', 'gift', 'gold'),
      ],
    }
    const report = verifyGuarantees(graph, [{ kind: 'exclusive', node: 'ship', other: 'gift' }])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].message).toContain('Tier\'s "gold" outcome')
  })

  it('fails when nothing decides between them at all', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        http('ship', {}, 'Ship'),
        http('gift', {}, 'Gift'),
      ],
      edges: [edge('hook', 'ship'), edge('hook', 'gift')],
    }
    const report = verifyGuarantees(graph, [{ kind: 'exclusive', node: 'ship', other: 'gift' }])
    expect(report.results[0].status).toBe('violated')
    expect(report.results[0].message).toContain('no decision separates')
  })

  it('fails when one side is also reachable around the decision', () => {
    // ship is on the condition's true branch *and* wired straight from the
    // trigger. The condition no longer keeps them apart, because ship does not
    // need it. Only a check that requires the decision to dominate both sees
    // this.
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('check', 'condition', {}, 'In stock?'),
        http('ship', {}, 'Ship'),
        http('refund', {}, 'Refund'),
      ],
      edges: [
        edge('hook', 'check'),
        edge('check', 'ship', 'true'),
        edge('check', 'refund', 'false'),
        edge('hook', 'ship'),
      ],
    }
    expect(statuses(graph, [{ kind: 'exclusive', node: 'ship', other: 'refund' }])).toEqual([
      'exclusive:violated',
    ])
  })

  it('holds across a nested decision inside one branch', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('check', 'condition', {}, 'Paid?'),
        node('tier', 'condition', {}, 'Express?'),
        http('fast', {}, 'Fast ship'),
        http('slow', {}, 'Slow ship'),
        http('refund', {}, 'Refund'),
      ],
      edges: [
        edge('hook', 'check'),
        edge('check', 'tier', 'true'),
        edge('tier', 'fast', 'true'),
        edge('tier', 'slow', 'false'),
        edge('check', 'refund', 'false'),
      ],
    }
    expect(
      statuses(graph, [
        { kind: 'exclusive', node: 'fast', other: 'slow' },
        { kind: 'exclusive', node: 'fast', other: 'refund' },
      ])
    ).toEqual(['exclusive:holds', 'exclusive:holds'])
  })
})

describe('declarations', () => {
  it('drops malformed, self-referential, and duplicate entries', () => {
    expect(
      parseGuarantees([
        { kind: 'requires', node: 'a', other: 'b' },
        { kind: 'requires', node: 'a', other: 'b' }, // duplicate
        { kind: 'nonsense', node: 'a', other: 'b' },
        { kind: 'requires', node: 'a', other: 'a' }, // tautology or typo
        { kind: 'requires', node: 'a' },
        null,
        'nope',
      ])
    ).toEqual([{ kind: 'requires', node: 'a', other: 'b' }])
  })

  it('accepts a JSON string, and survives one that isn’t JSON', () => {
    expect(parseGuarantees('[{"kind":"ensures","node":"a","other":"b"}]')).toHaveLength(1)
    expect(parseGuarantees('{{')).toEqual([])
  })

  it('reads each kind left to right', () => {
    const report = verifyGuarantees(approvalFlow(), [
      { kind: 'requires', node: 'charge', other: 'approve' },
      { kind: 'ensures', node: 'approve', other: 'charge' },
      { kind: 'exclusive', node: 'charge', other: 'decline' },
    ])
    expect(report.results.map((r) => r.statement)).toEqual([
      'Charge card never runs unless Approve ran first',
      'if Approve runs, Charge card runs too',
      'Charge card and Log decline never both run',
    ])
  })
})

describe('when the graph cannot be verified', () => {
  it('reports unknown rather than holds for a deleted node', () => {
    // The dangerous case: somebody deletes the approval, and every guarantee
    // about it starts passing because there is nothing left to violate.
    const graph = approvalFlow()
    graph.nodes = graph.nodes.filter((n) => n.id !== 'approve')
    graph.edges = graph.edges.filter((e) => e.source !== 'approve' && e.target !== 'approve')
    const report = verifyGuarantees(graph, [
      { kind: 'requires', node: 'charge', other: 'approve' },
    ])
    expect(report.results[0].status).toBe('unknown')
    expect(report.results[0].message).toContain('no longer in this workflow')
  })

  it('reports unknown for every guarantee when the graph has a cycle', () => {
    const graph = {
      nodes: [node('a', 'transform'), node('b', 'transform'), node('c', 'transform')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
    }
    const report = verifyGuarantees(graph, [{ kind: 'requires', node: 'c', other: 'a' }])
    expect(report.ok).toBe(false)
    expect(report.reason).toBe('cycle')
    expect(report.results[0].status).toBe('unknown')
  })
})

describe('derived facts', () => {
  it('reports which nodes every run executes', () => {
    const report = verifyGuarantees(approvalFlow(), [])
    const always = report.facts.alwaysRuns.map((f) => f.nodeId).sort()
    expect(always).toEqual(['approve', 'hook'])
  })

  it('counts an unconditional fan-out as always running, on both sides', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('a', 'output-log', {}, 'A'),
        node('b', 'output-log', {}, 'B'),
      ],
      edges: [edge('hook', 'a'), edge('hook', 'b')],
    }
    const always = verifyGuarantees(graph, []).facts.alwaysRuns.map((f) => f.nodeId).sort()
    expect(always).toEqual(['a', 'b', 'hook'])
  })

  it('lists the decisions and their outcomes', () => {
    const report = verifyGuarantees(approvalFlow(), [])
    expect(report.facts.decisions).toEqual([
      { nodeId: 'approve', label: 'Approve', outcomes: ['true', 'false'] },
    ])
  })
})

describe('suggestions', () => {
  it('offers the nearest gate in front of an effect, not every gate above it', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('valid', 'validate', { schema: '{}' }, 'Validate'),
        node('approve', 'approval', {}, 'Approve'),
        http('charge', {}, 'Charge'),
      ],
      edges: [
        edge('hook', 'valid'),
        edge('valid', 'approve', 'valid'),
        edge('approve', 'charge', 'true'),
      ],
    }
    const requires = verifyGuarantees(graph, []).suggestions.filter((s) => s.kind === 'requires')
    expect(requires).toEqual([
      {
        kind: 'requires',
        node: 'charge',
        other: 'approve',
        statement: 'Charge never runs unless Approve ran first',
      },
    ])
  })

  it('offers exclusivity for effects a branch already separates', () => {
    const graph = {
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Hook'),
        node('check', 'condition', {}, 'In stock?'),
        http('ship', {}, 'Ship'),
        http('refund', {}, 'Refund'),
      ],
      edges: [
        edge('hook', 'check'),
        edge('check', 'ship', 'true'),
        edge('check', 'refund', 'false'),
      ],
    }
    const exclusive = verifyGuarantees(graph, []).suggestions.filter((s) => s.kind === 'exclusive')
    expect(exclusive).toHaveLength(1)
    expect(exclusive[0].statement).toBe('Ship and Refund never both run')
  })

  it('says nothing about a graph with no gates and no effects', () => {
    const graph = {
      nodes: [node('hook', 'trigger-manual', {}, 'Hook'), node('log', 'output-log', {}, 'Log')],
      edges: [edge('hook', 'log')],
    }
    expect(verifyGuarantees(graph, []).suggestions).toEqual([])
  })
})

describe('linter integration', () => {
  it('says nothing when no guarantees are declared', () => {
    expect(guaranteeIssues(approvalFlow(), [])).toEqual([])
  })

  it('raises an error on a violation, anchored to the node it is about', () => {
    const graph = approvalFlow()
    graph.edges.push(edge('hook', 'charge'))
    const issues = guaranteeIssues(graph, [{ kind: 'requires', node: 'charge', other: 'approve' }])
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('error')
    expect(issues[0].code).toBe('guarantee-violated')
    expect(issues[0].nodeId).toBe('charge')
    expect(issues[0].message).toContain('no longer holds')
  })

  it('warns — not errors — when a guarantee can no longer be checked', () => {
    const graph = approvalFlow()
    graph.nodes = graph.nodes.filter((n) => n.id !== 'approve')
    graph.edges = graph.edges.filter((e) => e.source !== 'approve' && e.target !== 'approve')
    const issues = guaranteeIssues(graph, [{ kind: 'requires', node: 'charge', other: 'approve' }])
    expect(issues[0].code).toBe('guarantee-uncheckable')
    expect(issues[0].severity).toBe('warning')
  })
})

describe('analyzeGraph', () => {
  it('refuses an empty graph rather than reporting vacuous truths', () => {
    expect(analyzeGraph({ nodes: [], edges: [] })).toMatchObject({ ok: false, reason: 'empty' })
  })
})
