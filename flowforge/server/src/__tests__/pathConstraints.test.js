// Path feasibility over a canvas: which branches an input can take, which no
// input can, and what payload drives each one.
//
// The assertions are grouped by the property they defend, because this analysis
// has exactly one way of being harmful. **A branch reported dead must really be
// dead** — anything the fragment cannot decide, anything two nodes might have
// written, anything the search did not finish has to come back reachable or
// unknown. So most of what is pinned here is restraint: the cases where the
// answer is deliberately "no finding".

const { analyzePaths, pathIssues, outcomeAssertion } = require('../services/pathConstraints')

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

const expr = (id, expression, label = id) =>
  node(id, 'condition', { operator: 'expression', expression }, label)

const branchOf = (report, nodeId, outcome) =>
  report.branches.find((b) => b.nodeId === nodeId && b.outcome === outcome)

describe('reachability of a branch', () => {
  it('finds a payload that takes each side of a condition', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook', {}, 'Order webhook'),
        expr('big', 'amount > 1000', 'Large order'),
        node('vip', 'action-http', {}, 'VIP path'),
        node('normal', 'action-http', {}, 'Normal path'),
      ],
      edges: [edge('hook', 'big'), edge('big', 'vip', 'true'), edge('big', 'normal', 'false')],
    })

    expect(report.analysed).toBe(true)
    expect(branchOf(report, 'big', 'true').status).toBe('reachable')
    expect(branchOf(report, 'big', 'false').status).toBe('reachable')
    expect(branchOf(report, 'big', 'true').witness.triggerData.amount).toBeGreaterThan(1000)
    expect(branchOf(report, 'big', 'false').witness.triggerData.amount).toBeLessThanOrEqual(1000)
  })

  // A condition emits `{ result }` and nothing else, so a second condition
  // below it re-reads the trigger through a template rather than through the
  // merged input. That is the realistic shape of a two-condition chain, and it
  // is also the case that proves the two reference styles resolve to one
  // variable: `amount` in an expression beside the trigger, and
  // `{{hook.amount}}` further down.
  const chain = {
    nodes: [
      node('hook', 'trigger-webhook', {}, 'Order webhook'),
      expr('small', 'amount < 100', 'Small order'),
      node(
        'big',
        'condition',
        { operator: 'greater_than', left: '{{hook.amount}}', right: '1000' },
        'Large order'
      ),
      node('discount', 'action-http', {}, 'Apply discount'),
      node('gift', 'action-http', {}, 'Send a gift'),
    ],
    edges: [
      edge('hook', 'small'),
      edge('small', 'big', 'true'),
      edge('big', 'gift', 'true'),
      edge('big', 'discount', 'false'),
    ],
  }

  it('reports the branch a chain of conditions has already ruled out', () => {
    const report = analyzePaths(chain)

    expect(branchOf(report, 'big', 'true').status).toBe('unreachable')
    expect(branchOf(report, 'big', 'false').status).toBe('reachable')

    const finding = report.findings.find((f) => f.code === 'unreachable-branch')
    expect(finding.severity).toBe('error')
    expect(finding.nodeId).toBe('big')
    // The evidence is the whole point: which decision it contradicts.
    expect(finding.message).toMatch(/Small order → true/)
  })

  it('does not report the node behind a dead branch a second time', () => {
    const report = analyzePaths({
      ...chain,
      edges: chain.edges.filter((e) => e.target !== 'discount'),
    })

    expect(report.findings.filter((f) => f.code === 'unreachable-branch')).toHaveLength(1)
    expect(report.findings.filter((f) => f.code === 'unreachable-node')).toHaveLength(0)
  })

  it('reads a bare identifier against the merge, not against everything upstream', () => {
    // `amount` below a condition is not in scope at all — the condition's
    // output is `{ result }` — so the expression constrains a variable of its
    // own and the analysis stays quiet rather than inventing a contradiction.
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        expr('small', 'amount < 100'),
        expr('big', 'amount > 1000'),
        node('gift', 'action-http'),
      ],
      edges: [edge('hook', 'small'), edge('small', 'big', 'true'), edge('big', 'gift', 'true')],
    })
    expect(report.findings).toHaveLength(0)
  })
})

describe('switch cases', () => {
  const switchGraph = (cases) => ({
    nodes: [
      node('hook', 'trigger-webhook'),
      node('route', 'switch', { cases }, 'Route'),
      node('a', 'output-log'),
      node('b', 'output-log'),
      node('other', 'output-log'),
    ],
    edges: [
      edge('hook', 'route'),
      edge('route', 'a', cases[0]?.label),
      edge('route', 'b', cases[1]?.label),
      edge('route', 'other', 'default'),
    ],
  })

  it('drives each labelled case and the default', () => {
    const report = analyzePaths(
      switchGraph([
        { label: 'refund', expression: 'kind == "refund"' },
        { label: 'order', expression: 'kind == "order"' },
      ])
    )
    expect(branchOf(report, 'route', 'refund').witness.triggerData.kind).toBe('refund')
    expect(branchOf(report, 'route', 'order').witness.triggerData.kind).toBe('order')
    expect(branchOf(report, 'route', 'default').status).toBe('reachable')
    expect(branchOf(report, 'route', 'default').witness.triggerData.kind).not.toBe('refund')
  })

  it('reports a case an earlier one already swallowed', () => {
    // The first case matches everything the second would have.
    const report = analyzePaths(
      switchGraph([
        { label: 'wide', expression: 'amount > 10' },
        { label: 'narrow', expression: 'amount > 100' },
      ])
    )
    expect(branchOf(report, 'route', 'wide').status).toBe('reachable')
    expect(branchOf(report, 'route', 'narrow').status).toBe('unreachable')
    expect(report.findings.some((f) => f.nodeId === 'route')).toBe(true)
  })

  it('reports a default that no input can fall through to', () => {
    const report = analyzePaths(
      switchGraph([
        { label: 'low', expression: 'amount <= 100' },
        { label: 'high', expression: 'amount > 100' },
      ])
    )
    expect(branchOf(report, 'route', 'default').status).toBe('unreachable')
  })
})

describe('restraint — what must not be reported', () => {
  it('says nothing about a comparison outside the fragment', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        node('c1', 'condition', { operator: 'contains', left: '{{hook.name}}', right: 'acme' }),
        node('c2', 'condition', { operator: 'contains', left: '{{hook.name}}', right: 'zzz' }),
        node('sink', 'output-log'),
      ],
      edges: [edge('hook', 'c1'), edge('c1', 'c2', 'true'), edge('c2', 'sink', 'true')],
    })
    expect(report.findings).toHaveLength(0)
    expect(branchOf(report, 'c2', 'true').status).toBe('reachable')
  })

  it('does not correlate a field two nodes could have written', () => {
    // A transform emits `amount` too, so the condition below it is reading a
    // value the trigger's `amount` says nothing about. Merging them would make
    // the second branch look dead; splitting them keeps the analysis quiet.
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        expr('big', 'amount > 1000'),
        node('tx', 'transform', { template: { amount: 5 } }),
        expr('small', 'amount < 100'),
        node('sink', 'output-log'),
      ],
      edges: [
        edge('hook', 'big'),
        edge('big', 'tx', 'true'),
        edge('tx', 'small'),
        edge('small', 'sink', 'true'),
      ],
    })
    expect(report.findings).toHaveLength(0)
    expect(branchOf(report, 'small', 'true').status).not.toBe('unreachable')
  })

  it('keeps the two sides of a schema gate apart without claiming to know a schema', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        node('gate', 'validate', { schema: { type: 'object' } }, 'Schema gate'),
        node('ok', 'output-log'),
        node('bad', 'output-log'),
      ],
      edges: [edge('hook', 'gate'), edge('gate', 'ok', 'valid'), edge('gate', 'bad', 'invalid')],
    })
    expect(branchOf(report, 'gate', 'valid').status).toBe('reachable')
    expect(branchOf(report, 'gate', 'invalid').status).toBe('reachable')
    expect(report.findings).toHaveLength(0)
  })

  it('refuses to analyse a graph that cannot run', () => {
    const cyclic = analyzePaths({
      nodes: [node('a', 'condition'), node('b', 'condition')],
      edges: [edge('a', 'b', 'true'), edge('b', 'a', 'true')],
    })
    expect(cyclic.analysed).toBe(false)
    expect(cyclic.reason).toBe('cycle')
    expect(cyclic.findings).toHaveLength(0)

    const empty = analyzePaths({ nodes: [], edges: [] })
    expect(empty.analysed).toBe(false)
    expect(empty.findings).toHaveLength(0)
  })

  it('is silent about a graph with no decisions at all', () => {
    const report = analyzePaths({
      nodes: [node('hook', 'trigger-webhook'), node('log', 'output-log')],
      edges: [edge('hook', 'log')],
    })
    expect(report.findings).toHaveLength(0)
    expect(report.branches).toHaveLength(0)
    expect(report.coverage.branches).toBe(0)
  })

  it('leaves an unwired outcome out of the findings', () => {
    // A dangling `false` handle is a linter concern, not a feasibility one —
    // and an outcome nothing is wired to cannot be a dead branch.
    const report = analyzePaths({
      nodes: [node('hook', 'trigger-webhook'), expr('c', 'amount > 5'), node('sink', 'output-log')],
      edges: [edge('hook', 'c'), edge('c', 'sink', 'true')],
    })
    expect(branchOf(report, 'c', 'false').wired).toBe(0)
    expect(report.findings).toHaveLength(0)
  })
})

describe('generated scenarios', () => {
  it('writes a payload and an assertion per drivable branch', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        node('route', 'switch', {
          cases: [
            { label: 'refund', expression: 'kind == "refund"' },
            { label: 'order', expression: 'kind == "order"' },
          ],
        }, 'Route'),
        node('a', 'output-log'),
        node('b', 'output-log'),
        node('c', 'output-log'),
      ],
      edges: [
        edge('hook', 'route'),
        edge('route', 'a', 'refund'),
        edge('route', 'b', 'order'),
        edge('route', 'c', 'default'),
      ],
    })

    expect(report.scenarios).toHaveLength(3)
    const refund = report.scenarios.find((s) => s.covers.outcome === 'refund')
    expect(refund.name).toBe('Route → refund')
    expect(refund.triggerData).toEqual({ kind: 'refund' })
    expect(refund.assertions[0].expression).toBe('steps["route"].result == "refund"')
    expect(report.coverage).toEqual({ branches: 3, reachable: 3, generatable: 3 })
  })

  it('will not write a scenario for a branch a payload cannot drive', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        node('approve', 'approval', {}, 'Approve'),
        node('charge', 'action-http', {}, 'Charge card'),
        node('drop', 'output-log', {}, 'Reject'),
      ],
      edges: [
        edge('hook', 'approve'),
        edge('approve', 'charge', 'true'),
        edge('approve', 'drop', 'false'),
      ],
    })

    // Test mode auto-approves, so the approved side is drivable and the
    // rejected side is not — and the reason is stated rather than implied.
    expect(branchOf(report, 'approve', 'true').generatable).toBe(true)
    const rejected = branchOf(report, 'approve', 'false')
    expect(rejected.status).toBe('reachable')
    expect(rejected.generatable).toBe(false)
    expect(rejected.blockers[0]).toMatch(/test mode/)
    expect(report.scenarios.map((s) => s.covers.outcome)).toEqual(['true'])
  })

  it('will not write a scenario that secretly depends on an upstream response', () => {
    const report = analyzePaths({
      nodes: [
        node('hook', 'trigger-webhook'),
        node('call', 'action-http', { url: 'https://api.example.com', method: 'GET' }, 'Fetch'),
        expr('ok', 'status == 200', 'Succeeded?'),
        node('sink', 'output-log'),
        node('alt', 'output-log'),
      ],
      edges: [
        edge('hook', 'call'),
        edge('call', 'ok'),
        edge('ok', 'sink', 'true'),
        edge('ok', 'alt', 'false'),
      ],
    })

    const covered = branchOf(report, 'ok', 'true')
    expect(covered.status).toBe('reachable')
    expect(covered.generatable).toBe(false)
    expect(covered.blockers[0]).toMatch(/call\.status/)
    expect(covered.witness.assumptions).toContainEqual({ variable: 'call.status', value: 200 })
    expect(report.scenarios).toHaveLength(0)
  })

  it('names the right assertion for each kind of decision', () => {
    expect(outcomeAssertion(node('c', 'condition'), 'true')).toBe('steps["c"].result == true')
    expect(outcomeAssertion(node('c', 'condition'), 'false')).toBe('steps["c"].result == false')
    expect(outcomeAssertion(node('s', 'switch'), 'refund')).toBe('steps["s"].result == "refund"')
    expect(outcomeAssertion(node('v', 'validate'), 'valid')).toBe('steps["v"].result == "valid"')
    expect(outcomeAssertion(node('h', 'action-http'), 'error')).toBe('steps["h"] != null')
  })
})

describe('linter integration', () => {
  it('passes only the errors through', () => {
    const issues = pathIssues({
      nodes: [
        node('hook', 'trigger-webhook'),
        expr('small', 'amount < 100', 'Small'),
        node('big', 'condition', { operator: 'greater_than', left: '{{hook.amount}}', right: '1000' }, 'Big'),
        node('gift', 'output-log'),
      ],
      edges: [edge('hook', 'small'), edge('small', 'big', 'true'), edge('big', 'gift', 'true')],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('unreachable-branch')
  })

  it('reports nothing for a graph it could not fully explore', () => {
    expect(pathIssues({ nodes: [], edges: [] })).toEqual([])
  })
})
