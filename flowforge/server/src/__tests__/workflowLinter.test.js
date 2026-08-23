// The workflow linter: structural rules (cycles, dangling edges, reachability),
// per-type config rules, template-reference resolution, and the lint route's
// workspace context (secrets + sub-workflow targets).

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { app } = require('../index')
const { lintGraph } = require('../services/workflowLinter')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

const codes = (issues) => issues.map((i) => i.code)

describe('lintGraph', () => {
  it('reports an empty graph and nothing else', () => {
    const issues = lintGraph({ nodes: [], edges: [] })
    expect(codes(issues)).toEqual(['empty-graph'])
  })

  it('passes a clean workflow with no issues', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { method: 'GET', url: 'https://api.example.com', headers: '{}' }),
        node('o1', 'output-log', { message: 'status: {{h1.status}}' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    expect(lintGraph(graph)).toEqual([])
  })

  it('flags cycles and dangling edges as errors', () => {
    const cycle = {
      nodes: [node('a', 'transform', { template: '{}' }), node('b', 'transform', { template: '{}' })],
      edges: [edge('a', 'b'), edge('b', 'a')],
    }
    expect(codes(lintGraph(cycle))).toContain('cycle')

    const dangling = {
      nodes: [node('t1', 'trigger-manual')],
      edges: [edge('t1', 'ghost')],
    }
    expect(codes(lintGraph(dangling))).toContain('dangling-edge')
  })

  it('warns when there is no trigger and when nodes are unreachable from one', () => {
    const noTrigger = {
      nodes: [node('h1', 'action-http', { url: 'https://x.example' })],
      edges: [],
    }
    expect(codes(lintGraph(noTrigger))).toContain('no-trigger')

    const island = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', {}),
        node('lost', 'output-log', {}),
      ],
      edges: [edge('t1', 'o1')],
    }
    const issues = lintGraph(island)
    const unreachable = issues.find((i) => i.code === 'unreachable-node')
    expect(unreachable).toBeTruthy()
    expect(unreachable.nodeId).toBe('lost')
  })

  it('requires per-type config: HTTP URL, Slack webhook, cron validity', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-schedule', { cron: 'not-a-cron' }),
        node('h1', 'action-http', { url: '' }),
        node('s1', 'action-slack', { webhookUrl: '', text: 'hi' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 's1')],
    }
    const issues = lintGraph(graph)
    expect(codes(issues)).toEqual(expect.arrayContaining(['invalid-cron', 'missing-config']))
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(3)
  })

  it('flags references to unknown nodes as errors and non-upstream ones as warnings', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('a', 'transform', { template: '{"x": "{{ghost.field}}"}' }),
        node('b', 'transform', { template: '{"y": "{{c.value}}"}' }), // c is a sibling, not upstream
        node('c', 'transform', { template: '{"z": 1}' }),
      ],
      edges: [edge('t1', 'a'), edge('a', 'b'), edge('a', 'c')],
    }
    const issues = lintGraph(graph)
    const unknown = issues.find((i) => i.code === 'unknown-node-ref')
    expect(unknown).toMatchObject({ severity: 'error', nodeId: 'a' })
    const sibling = issues.find((i) => i.code === 'non-upstream-ref')
    expect(sibling).toMatchObject({ severity: 'warning', nodeId: 'b' })
  })

  it('checks {{secrets.*}} against the workspace secret names when provided', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', {
          url: 'https://api.example.com',
          headers: '{"Authorization": "Bearer {{secrets.MISSING_KEY}}"}',
        }),
      ],
      edges: [edge('t1', 'h1')],
    }
    // Without context the rule is skipped entirely.
    expect(codes(lintGraph(graph))).toEqual([])

    const issues = lintGraph(graph, { secretNames: new Set(['OTHER_KEY']) })
    expect(issues.find((i) => i.code === 'unknown-secret')).toMatchObject({
      severity: 'error',
      nodeId: 'h1',
    })
  })

  it('checks {{vars.*}} against the workspace variable names when provided', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { url: '{{vars.API_BASE_URL}}/orders' }),
      ],
      edges: [edge('t1', 'h1')],
    }
    // Without context the rule is skipped entirely — and the vars head is
    // never mistaken for a node reference.
    expect(codes(lintGraph(graph))).toEqual([])

    expect(codes(lintGraph(graph, { variableNames: new Set(['API_BASE_URL']) }))).toEqual([])

    const issues = lintGraph(graph, { variableNames: new Set(['OTHER_VAR']) })
    expect(issues.find((i) => i.code === 'unknown-variable')).toMatchObject({
      severity: 'error',
      nodeId: 'h1',
    })
  })

  it('validates sub-workflow targets against the workspace', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('sub', 'sub-workflow', { workflowId: 'wf-draft' }),
        node('sub2', 'sub-workflow', { workflowId: 'wf-gone' }),
      ],
      edges: [edge('t1', 'sub'), edge('sub', 'sub2')],
    }
    const targets = new Map([['wf-draft', { name: 'Draft one', status: 'draft' }]])
    const issues = lintGraph(graph, { workflowTargets: targets })
    expect(issues.find((i) => i.code === 'undeployed-target')).toMatchObject({ nodeId: 'sub' })
    expect(issues.find((i) => i.code === 'missing-target')).toMatchObject({ nodeId: 'sub2' })
  })

  it('warns about half-wired condition branches', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { left: '{{t1.x}}', operator: 'equals', right: '1' }),
        node('yes', 'output-log', {}),
      ],
      edges: [edge('t1', 'c1'), edge('c1', 'yes', 'true')],
    }
    const issues = lintGraph(graph)
    expect(issues.find((i) => i.code === 'unwired-branch')).toMatchObject({
      nodeId: 'c1',
      severity: 'warning',
    })
    expect(issues.find((i) => i.code === 'unwired-branch').message).toMatch(/false branch/)
  })

  describe('FXL expression static analysis', () => {
    const withTrigger = (n) => ({
      nodes: [node('t1', 'trigger-manual'), n],
      edges: [edge('t1', n.id)],
    })

    it('accepts a valid condition expression', () => {
      const graph = withTrigger(
        node('c1', 'condition', { operator: 'expression', expression: 'amount > 1000 && status == "open"' })
      )
      expect(codes(lintGraph(graph))).not.toEqual(expect.arrayContaining(['invalid-expression', 'missing-config']))
    })

    it('flags a syntax error in a condition expression as an error', () => {
      const graph = withTrigger(
        node('c1', 'condition', { operator: 'expression', expression: 'amount > ' })
      )
      const found = lintGraph(graph).find((i) => i.code === 'invalid-expression')
      expect(found).toMatchObject({ nodeId: 'c1', severity: 'error' })
      expect(found.message).toMatch(/syntax error/)
    })

    it('requires a non-empty condition expression', () => {
      const graph = withTrigger(
        node('c1', 'condition', { operator: 'expression', expression: '' })
      )
      expect(lintGraph(graph).find((i) => i.nodeId === 'c1')).toMatchObject({
        code: 'missing-config',
        severity: 'error',
      })
    })

    it('flags a call to an unknown function', () => {
      const graph = withTrigger(
        node('c1', 'condition', { operator: 'expression', expression: 'uppr(name) == "X"' })
      )
      const found = lintGraph(graph).find((i) => i.code === 'unknown-function')
      expect(found).toMatchObject({ nodeId: 'c1', severity: 'error' })
      expect(found.message).toMatch(/uppr/)
    })

    it('does not analyse the simple comparison operator as an expression', () => {
      const graph = withTrigger(
        node('c1', 'condition', { left: '{{t1.x}}', operator: 'equals', right: '1' })
      )
      expect(codes(lintGraph(graph))).not.toEqual(expect.arrayContaining(['invalid-expression']))
    })

    it('validates a filter predicate and warns on a missing source', () => {
      const graph = withTrigger(
        node('f1', 'filter', { predicate: 'price > 10', source: '' })
      )
      const issues = lintGraph(graph)
      expect(issues.find((i) => i.nodeId === 'f1' && i.severity === 'warning').message).toMatch(/source/)

      const broken = withTrigger(node('f1', 'filter', { predicate: 'price >', source: '{{t1.list}}' }))
      expect(lintGraph(broken).find((i) => i.code === 'invalid-expression')).toMatchObject({ nodeId: 'f1' })
    })

    it('accepts a well-formed switch and rejects broken cases', () => {
      const ok = withTrigger(
        node('sw', 'switch', {
          cases: [
            { label: 'high', expression: 'amount > 1000' },
            { label: 'mid', expression: 'amount > 100' },
          ],
        })
      )
      expect(codes(lintGraph(ok))).not.toEqual(
        expect.arrayContaining(['invalid-expression', 'missing-config', 'invalid-config'])
      )

      // A syntax error in a case surfaces as invalid-expression on the node.
      const broken = withTrigger(
        node('sw', 'switch', { cases: [{ label: 'x', expression: 'amount >' }] })
      )
      expect(lintGraph(broken).find((i) => i.code === 'invalid-expression')).toMatchObject({ nodeId: 'sw' })
    })

    it('flags a switch with no cases, blank labels, duplicates, and the reserved default', () => {
      const empty = withTrigger(node('sw', 'switch', { cases: [] }))
      expect(lintGraph(empty).find((i) => i.nodeId === 'sw')).toMatchObject({ code: 'missing-config' })

      const noLabel = withTrigger(node('sw', 'switch', { cases: [{ label: '', expression: 'true' }] }))
      expect(lintGraph(noLabel).find((i) => i.code === 'missing-config' && /no label/.test(i.message)))
        .toBeTruthy()

      const dupes = withTrigger(
        node('sw', 'switch', {
          cases: [
            { label: 'a', expression: 'x > 1' },
            { label: 'a', expression: 'x > 2' },
          ],
        })
      )
      expect(lintGraph(dupes).find((i) => /duplicate case label/.test(i.message)))
        .toMatchObject({ nodeId: 'sw', severity: 'error' })

      const reserved = withTrigger(
        node('sw', 'switch', { cases: [{ label: 'default', expression: 'x > 1' }] })
      )
      expect(lintGraph(reserved).find((i) => /reserved/.test(i.message)))
        .toMatchObject({ nodeId: 'sw', severity: 'error' })
    })

    it('requires a valid JSON Schema on a validate node', () => {
      const ok = withTrigger(node('v', 'validate', { schema: '{"type":"object"}' }))
      expect(codes(lintGraph(ok))).not.toEqual(
        expect.arrayContaining(['missing-config', 'invalid-config'])
      )

      const missing = withTrigger(node('v', 'validate', { schema: '' }))
      expect(lintGraph(missing).find((i) => i.nodeId === 'v')).toMatchObject({ code: 'missing-config' })

      const broken = withTrigger(node('v', 'validate', { schema: '{not json' }))
      expect(lintGraph(broken).find((i) => i.nodeId === 'v')).toMatchObject({ code: 'invalid-config' })
    })

    it('validates a map expression', () => {
      const ok = withTrigger(node('m1', 'map', { mapping: '{ id: item.id }', source: '{{t1.list}}' }))
      expect(codes(lintGraph(ok))).not.toEqual(expect.arrayContaining(['invalid-expression', 'missing-config']))

      const broken = withTrigger(node('m1', 'map', { mapping: '{ id: }', source: '{{t1.list}}' }))
      expect(lintGraph(broken).find((i) => i.code === 'invalid-expression')).toMatchObject({ nodeId: 'm1' })

      const blank = withTrigger(node('m1', 'map', { mapping: '', source: '{{t1.list}}' }))
      expect(lintGraph(blank).find((i) => i.nodeId === 'm1')).toMatchObject({ code: 'missing-config' })
    })

    it('treats aggregate value / group-by as optional but still syntax-checks them', () => {
      // Count-only aggregate (no value, no groupBy) with a source is clean.
      const clean = withTrigger(node('g1', 'aggregate', { source: '{{t1.list}}' }))
      expect(codes(lintGraph(clean))).not.toEqual(
        expect.arrayContaining(['invalid-expression', 'missing-config'])
      )

      // A broken value expression is still an error.
      const broken = withTrigger(node('g1', 'aggregate', { source: '{{t1.list}}', value: 'amount +' }))
      expect(lintGraph(broken).find((i) => i.code === 'invalid-expression')).toMatchObject({ nodeId: 'g1' })
    })
  })

  it('warns about half-wired approval branches with approved/rejected names', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('gate', 'approval', { message: 'Ship it?' }),
        node('yes', 'output-log', {}),
      ],
      edges: [edge('t1', 'gate'), edge('gate', 'yes', 'true')],
    }
    const issues = lintGraph(graph)
    expect(issues.find((i) => i.code === 'unwired-branch')).toMatchObject({
      nodeId: 'gate',
      severity: 'warning',
    })
    expect(issues.find((i) => i.code === 'unwired-branch').message).toMatch(/rejected branch/)
  })

  it('warns about invalid approval timeout and on-timeout values', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('gate', 'approval', { timeoutMinutes: '-5', onTimeout: 'explode' }),
        node('yes', 'output-log', {}),
        node('no', 'output-log', {}),
      ],
      edges: [
        edge('t1', 'gate'),
        edge('gate', 'yes', 'true'),
        edge('gate', 'no', 'false'),
      ],
    }
    const issues = lintGraph(graph)
    const invalid = issues.filter((i) => i.code === 'invalid-config')
    expect(invalid).toHaveLength(2)
    expect(invalid.every((i) => i.severity === 'warning' && i.nodeId === 'gate')).toBe(true)

    // Valid config raises neither.
    const ok = lintGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === 'gate' ? node('gate', 'approval', { timeoutMinutes: 30, onTimeout: 'fail' }) : n
      ),
    })
    expect(codes(ok)).not.toContain('invalid-config')
  })

  it('sorts errors before warnings', () => {
    const graph = {
      nodes: [
        node('h1', 'action-http', { url: '' }), // error + no-trigger warning
      ],
      edges: [],
    }
    const issues = lintGraph(graph)
    expect(issues[0].severity).toBe('error')
    expect(issues[issues.length - 1].severity).toBe('warning')
  })

  describe('sticky notes', () => {
    it('notes raise no issues and are invisible to reachability checks', () => {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          node('o1', 'output-log', { message: 'hi' }),
          node('memo', 'note', { text: 'context for the next person' }),
        ],
        edges: [edge('t1', 'o1')],
      }
      expect(lintGraph(graph)).toEqual([])
    })

    it('a graph of only notes still reads as empty', () => {
      const graph = {
        nodes: [node('memo', 'note', { text: 'todo: build this' })],
        edges: [],
      }
      expect(codes(lintGraph(graph))).toEqual(['empty-graph'])
    })
  })

  describe('on-error policy wiring', () => {
    const httpNode = (id, onError) =>
      node(id, 'action-http', {
        method: 'GET',
        url: 'https://api.example.com',
        headers: '{}',
        ...(onError ? { onError } : {}),
      })

    it('accepts a correctly wired error branch', () => {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          httpNode('h1', 'branch'),
          node('ok', 'output-log', { message: 'ok' }),
          node('err', 'output-log', { message: 'err' }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'ok'), edge('h1', 'err', 'error')],
      }
      expect(lintGraph(graph)).toEqual([])
    })

    it('flags an error edge whose source policy is not branch', () => {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          httpNode('h1', 'continue'),
          node('err', 'output-log', { message: 'err' }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'err', 'error')],
      }
      const issues = lintGraph(graph)
      const dead = issues.find((i) => i.code === 'dead-error-branch')
      expect(dead).toBeTruthy()
      expect(dead.severity).toBe('error')
      expect(dead.nodeId).toBe('h1')
    })

    it('warns when the branch policy has no error edge connected', () => {
      const graph = {
        nodes: [node('t1', 'trigger-manual'), httpNode('h1', 'branch')],
        edges: [edge('t1', 'h1')],
      }
      const issues = lintGraph(graph)
      const unwired = issues.find(
        (i) => i.code === 'unwired-branch' && i.nodeId === 'h1'
      )
      expect(unwired).toBeTruthy()
      expect(unwired.severity).toBe('warning')
    })

    it('flags miswired callback gates and callback references', () => {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          node('h1', 'action-http', {
            method: 'POST',
            url: 'https://api.example.com/jobs',
            headers: '{}',
            body: '{"callbackUrl": "{{callbacks.w1}}"}',
          }),
          node('w1', 'wait-callback', { timeoutMinutes: 30 }),
          node('got', 'output-log', { message: 'ok' }),
          node('late', 'output-log', { message: 'late' }),
        ],
        edges: [
          edge('t1', 'h1'),
          edge('h1', 'w1'),
          edge('w1', 'got', 'received'),
          edge('w1', 'late', 'timed-out'),
        ],
      }
      // Fully wired: clean.
      expect(lintGraph(graph)).toEqual([])

      // Drop the timed-out edge: warn — unless onTimeout is 'fail', where
      // there is no timed-out branch to wire.
      const noTimeoutEdge = { ...graph, edges: graph.edges.slice(0, 3) }
      expect(
        lintGraph(noTimeoutEdge).find((i) => i.code === 'unwired-branch').message
      ).toMatch(/timed-out branch/)
      const failMode = {
        ...noTimeoutEdge,
        nodes: noTimeoutEdge.nodes.map((n) =>
          n.id === 'w1' ? node('w1', 'wait-callback', { timeoutMinutes: 30, onTimeout: 'fail' }) : n
        ),
      }
      expect(codes(lintGraph(failMode))).not.toContain('unwired-branch')

      // A callbacks reference must point at a wait-callback node.
      const badRef = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === 'h1'
            ? node('h1', 'action-http', {
                method: 'POST',
                url: 'https://api.example.com/jobs',
                headers: '{}',
                body: '{"callbackUrl": "{{callbacks.nope}}"}',
              })
            : n
        ),
      }
      const refIssue = lintGraph(badRef).find((i) => i.code === 'unknown-callback-ref')
      expect(refIssue).toBeTruthy()
      expect(refIssue.severity).toBe('error')

      // Invalid timeout / on-timeout values warn like approval's do.
      const badConfig = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === 'w1' ? node('w1', 'wait-callback', { timeoutMinutes: -5, onTimeout: 'retry' }) : n
        ),
      }
      const invalid = lintGraph(badConfig).filter(
        (i) => i.code === 'invalid-config' && i.nodeId === 'w1'
      )
      expect(invalid).toHaveLength(2)
    })

    it('warns on an unknown policy value and on uncatchable types', () => {
      const graph = {
        nodes: [
          node('t1', 'trigger-manual'),
          httpNode('h1', 'retry-forever'),
          node('c1', 'condition', { left: 'x', operator: 'equals', right: 'y', onError: 'continue' }),
        ],
        edges: [edge('t1', 'h1'), edge('h1', 'c1')],
      }
      const issues = lintGraph(graph).filter((i) => i.code === 'invalid-config')
      expect(issues.some((i) => i.nodeId === 'h1' && /on-error must be/.test(i.message))).toBe(true)
      expect(issues.some((i) => i.nodeId === 'c1' && /no effect/.test(i.message))).toBe(true)
    })
  })

  describe('step-cache config', () => {
    const cachedGraph = (nodeOverride) => ({
      nodes: [node('t1', 'trigger-manual'), nodeOverride],
      edges: [edge('t1', nodeOverride.id)],
    })

    it('accepts caching on a cacheable node with a sane TTL', () => {
      const graph = cachedGraph(
        node('h1', 'action-http', {
          method: 'GET', url: 'https://api.example.com', headers: '{}',
          cache: { enabled: true, ttlSeconds: 600 },
        })
      )
      expect(lintGraph(graph)).toEqual([])
    })

    it('warns when caching is enabled on a type the engine never caches', () => {
      const graph = cachedGraph(
        node('e1', 'action-email', { to: 'a@b.c', subject: 's', cache: { enabled: true } })
      )
      const issues = lintGraph(graph).filter((i) => i.nodeId === 'e1' && i.code === 'invalid-config')
      expect(issues.some((i) => /caching has no effect/.test(i.message))).toBe(true)
    })

    it('warns when a cached HTTP node is not a GET', () => {
      const graph = cachedGraph(
        node('h1', 'action-http', {
          method: 'POST', url: 'https://api.example.com', headers: '{}',
          cache: { enabled: true },
        })
      )
      const issues = lintGraph(graph)
      expect(codes(issues)).toContain('cached-side-effect')
      expect(issues.find((i) => i.code === 'cached-side-effect').message).toMatch(/POST/)
    })

    it('warns on a nonsense TTL and stays quiet when caching is off', () => {
      const bad = cachedGraph(
        node('m1', 'map', { source: '{{t1.items}}', mapping: 'item', cache: { enabled: true, ttlSeconds: 'soon' } })
      )
      const issues = lintGraph(bad).filter((i) => i.nodeId === 'm1' && i.code === 'invalid-config')
      expect(issues.some((i) => /cache TTL/.test(i.message))).toBe(true)

      const off = cachedGraph(
        node('e1', 'action-email', { to: 'a@b.c', subject: 's', cache: { enabled: false } })
      )
      expect(lintGraph(off)).toEqual([])
    })
  })
})

describe('POST /api/workflows/:id/lint', () => {
  let token
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'linter-user@example.com', password: 'password123', displayName: 'Linter' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function createWorkflow(graph) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Lintable' })
    const workflow = res.body.workflow
    if (graph) {
      await request(app)
        .put(`/api/workflows/${workflow.id}/graph`)
        .set('Authorization', `Bearer ${token}`)
        .send(graph)
    }
    return workflow
  }

  it('lints the stored graph when no body is posted', async () => {
    const workflow = await createWorkflow({
      nodes: [node('h1', 'action-http', { url: '' })],
      edges: [],
    })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.summary.errors).toBe(1)
    expect(res.body.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['missing-config', 'no-trigger'])
    )
  })

  it('lints a posted graph instead of the stored one', async () => {
    const workflow = await createWorkflow({ nodes: [], edges: [] })
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        nodes: [node('t1', 'trigger-manual'), node('o1', 'output-log', {})],
        edges: [edge('t1', 'o1')],
      })
    expect(res.status).toBe(200)
    expect(res.body.issues).toEqual([])
    expect(res.body.summary).toEqual({ errors: 0, warnings: 0 })
  })

  it('uses real workspace secrets for {{secrets.*}} checks', async () => {
    await request(app)
      .put(`/api/workspaces/${workspaceId}/secrets/API_KEY`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'shh-very-secret' })

    const workflow = await createWorkflow()
    const graphWith = (secretName) => ({
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', {
          url: 'https://api.example.com',
          headers: `{"Authorization": "Bearer {{secrets.${secretName}}}"}`,
        }),
      ],
      edges: [edge('t1', 'h1')],
    })

    const ok = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send(graphWith('API_KEY'))
    expect(ok.body.issues).toEqual([])

    const bad = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send(graphWith('NOPE'))
    expect(bad.body.issues.map((i) => i.code)).toContain('unknown-secret')
  })

  it('uses real workspace variables for {{vars.*}} checks', async () => {
    await request(app)
      .put(`/api/workspaces/${workspaceId}/variables/BASE_URL`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 'https://api.example.com' })

    const workflow = await createWorkflow()
    const graphWith = (varName) => ({
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { url: `{{vars.${varName}}}/orders` }),
      ],
      edges: [edge('t1', 'h1')],
    })

    const ok = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send(graphWith('BASE_URL'))
    expect(ok.body.issues).toEqual([])

    const bad = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${token}`)
      .send(graphWith('TYPO_URL'))
    expect(bad.body.issues.map((i) => i.code)).toContain('unknown-variable')
  })

  it('404s for non-members', async () => {
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'linter-outsider@example.com', password: 'password123', displayName: 'Out' })
    const workflow = await createWorkflow()
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/lint`)
      .set('Authorization', `Bearer ${outsider.body.token}`)
      .send({})
    expect(res.status).toBe(404)
  })
})

// Type analysis is the linter's last pass and the only one that reasons about
// the *data* moving between nodes rather than each node in isolation. These
// tests pin the two things that matter about it as a lint rule: that it catches
// what the structural passes cannot, and that it never re-reports what they
// already own.
describe('lintGraph — type analysis', () => {
  it('flags a reference to a field the upstream node cannot produce', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('h1', 'action-http', { url: 'https://api.example.com' }),
        node('o1', 'output-log', { message: 'code {{h1.stats}}' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    const found = lintGraph(graph).find((i) => i.code === 'unknown-field')
    expect(found).toMatchObject({ severity: 'error', nodeId: 'o1' })
    expect(found.message).toMatch(/has no "stats"; did you mean "status"\?/)
  })

  it('flags an expression that cannot typecheck against its real scope', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('f1', 'filter', { source: '[1, 2, 3]', predicate: 'item > 1' }),
        node('c1', 'condition', { operator: 'expression', expression: 'items * 2 > 4' }),
      ],
      edges: [edge('t1', 'f1'), edge('f1', 'c1')],
    }
    const found = lintGraph(graph).find((i) => i.code === 'type-error')
    expect(found).toMatchObject({ severity: 'error', nodeId: 'c1' })
    expect(found.message).toMatch(/c1: the condition expression: "\*" needs numbers/)
  })

  it('does not re-report a syntax error the expression pass already owns', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('c1', 'condition', { operator: 'expression', expression: 'amount >' }),
      ],
      edges: [edge('t1', 'c1')],
    }
    expect(codes(lintGraph(graph)).filter((c) => c !== 'unwired-branch'))
      .toEqual(['invalid-expression'])
  })

  it('stays silent on a graph built entirely from dynamic data', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('h1', 'action-http', { url: 'https://api.example.com/{{t1.orderId}}' }),
        node('o1', 'output-log', { message: 'total {{h1.body.order.total}}' }),
      ],
      edges: [edge('t1', 'h1'), edge('h1', 'o1')],
    }
    expect(lintGraph(graph)).toEqual([])
  })

  describe('idempotency declarations', () => {
    const withNode = (n) => ({ nodes: [node('t1', 'trigger-manual'), n], edges: [edge('t1', n.id)] })

    it('accepts it on a non-safe HTTP method', () => {
      const graph = withNode(
        node('h1', 'action-http', {
          method: 'POST',
          url: 'https://api.example.com/charge',
          headers: '{}',
          idempotent: true,
        })
      )
      expect(codes(lintGraph(graph))).not.toContain('invalid-config')
    })

    it('flags it on a node that cannot send the header', () => {
      // Worse than untidy: the recovery policy *acts* on this declaration, so it
      // would let a lost run re-execute a step on the strength of a header that
      // was never sent.
      const found = lintGraph(withNode(node('e1', 'action-email', {
        to: 'a@b.c', subject: 's', body: 'b', idempotent: true,
      }))).find((i) => i.message.includes('idempotency'))
      expect(found).toMatchObject({ severity: 'warning', nodeId: 'e1' })
      expect(found.message).toMatch(/only HTTP nodes send an idempotency key/)
    })

    it('nudges when the request was already safe to repeat', () => {
      const found = lintGraph(withNode(node('h1', 'action-http', {
        method: 'GET', url: 'https://api.example.com/x', headers: '{}', idempotent: true,
      }))).find((i) => i.message.includes('already safe to repeat'))
      expect(found).toMatchObject({ severity: 'warning', nodeId: 'h1' })
    })
  })

  // Path feasibility (services/pathConstraints.js) — the pass that reasons
  // about the data rather than the graph. Its own suite covers the analysis;
  // what matters here is that the linter runs it and that a graph it has
  // nothing to say about stays clean.
  it('flags a branch no input can take', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('c1', 'condition', { operator: 'expression', expression: 'amount < 100' }, 'Small'),
        node(
          'c2',
          'condition',
          { operator: 'greater_than', left: '{{t1.amount}}', right: '1000' },
          'Large'
        ),
        node('o1', 'output-log', { message: 'big' }),
        node('o2', 'output-log', { message: 'small' }),
      ],
      edges: [edge('t1', 'c1'), edge('c1', 'c2', 'true'), edge('c2', 'o1', 'true'), edge('c2', 'o2', 'false')],
    }
    const found = lintGraph(graph).find((i) => i.code === 'unreachable-branch')
    expect(found).toMatchObject({ severity: 'error', nodeId: 'c2' })
    expect(found.message).toMatch(/contradicts Small → true/)
  })

  it('says nothing about branches whose conditions are genuinely independent', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-webhook'),
        node('c1', 'condition', { operator: 'expression', expression: 'amount < 100' }),
        node('o1', 'output-log', { message: 'a' }),
        node('o2', 'output-log', { message: 'b' }),
      ],
      edges: [edge('t1', 'c1'), edge('c1', 'o1', 'true'), edge('c1', 'o2', 'false')],
    }
    expect(lintGraph(graph)).toEqual([])
  })
})

// Approval gates: quorum, required role, separation of duties. Every finding
// here has the same shape, and it is the shape a lint pass exists for — an
// unsatisfiable gate does not fail, it *waits*, and nobody discovers a
// four-approval gate in a three-person workspace until a production run is
// stuck behind it at 3am.
describe('approval gates', () => {
  // Both handles wired, so the baseline for these fixtures is an empty report
  // and every finding below is the one under test.
  const gateWith = (triggerId, triggerType) => (config) => ({
    nodes: [
      node(triggerId, triggerType),
      node('gate', 'approval', config, 'Refund gate'),
      node('pay', 'output-log', { message: 'paid' }),
      node('deny', 'output-log', { message: 'denied' }),
    ],
    edges: [
      edge(triggerId, 'gate'),
      edge('gate', 'pay', 'true'),
      edge('gate', 'deny', 'false'),
    ],
  })
  const gate = gateWith('t1', 'trigger-manual')
  const webhookGate = gateWith('hook', 'trigger-webhook')
  const codes = (graph, options) => lintGraph(graph, options).map((i) => i.code)
  const find = (graph, options, code) => lintGraph(graph, options).find((i) => i.code === code)

  const threePeople = { approvers: { members: 3, owners: 1 } }

  it('says nothing about an ordinary approval', () => {
    expect(codes(gate({ message: 'ok?' }), threePeople)).toEqual([])
  })

  it('accepts a quorum the workspace can satisfy', () => {
    expect(codes(gate({ quorum: 3 }), threePeople)).toEqual([])
  })

  it('refuses a quorum larger than the workspace', () => {
    const found = find(gate({ quorum: 4 }), threePeople, 'unsatisfiable-approval')
    expect(found.severity).toBe('error')
    expect(found.message).toMatch(/needs 4 approvals but this workspace has 3 members/)
    expect(found.message).toMatch(/can never pass/)
    expect(found.nodeId).toBe('gate')
  })

  it('counts owners, not members, for an owner-only gate', () => {
    // Three people can approve; only one of them is an owner.
    expect(codes(gate({ quorum: 2 }), threePeople)).toEqual([])
    const found = find(gate({ quorum: 2, approverRole: 'owner' }), threePeople, 'unsatisfiable-approval')
    expect(found.message).toMatch(/1 workspace owner/)
  })

  it('accounts for the person separation of duties will exclude', () => {
    // Three members, quorum three, and one of them starts the run: two left.
    const found = find(
      gate({ quorum: 3, separationOfDuties: true }),
      threePeople,
      'unsatisfiable-approval'
    )
    expect(found.severity).toBe('error')
    expect(found.message).toMatch(/a run they start can never be approved/)
  })

  it('does not deduct an excluded person on a workflow with no manual trigger', () => {
    // Nobody to exclude, so the pool is not reduced — a spurious error here
    // would send somebody to fix a correct graph.
    expect(codes(webhookGate({ quorum: 3, separationOfDuties: true }), threePeople))
      .toEqual(['inert-config'])
  })

  it('reports separation of duties that can never engage', () => {
    const found = find(webhookGate({ separationOfDuties: true }), threePeople, 'inert-config')
    expect(found.severity).toBe('warning')
    expect(found.message).toMatch(/no manual trigger/)
    expect(found.message).toMatch(/no user to exclude/)
  })

  it('stays silent about separation of duties on a manually-triggerable workflow', () => {
    expect(codes(gate({ separationOfDuties: true }), threePeople)).toEqual([])
  })

  it('warns about a quorum value the runner will clamp', () => {
    expect(find(gate({ quorum: 0 }), threePeople, 'invalid-config').message).toMatch(/whole number/)
    expect(find(gate({ quorum: 'two' }), threePeople, 'invalid-config').message).toMatch(/whole number/)
    expect(find(gate({ approverRole: 'admin' }), threePeople, 'invalid-config').message)
      .toMatch(/"any" or "owner"/)
  })

  it('checks nothing that needs a workspace when it was not given one', () => {
    // An exported file linted on its own gets the config checks and nothing
    // that would have to guess how many people exist somewhere else.
    expect(codes(gate({ quorum: 40 }))).toEqual([])
  })
})

// Two branches converging on one node, both supplying the same field. The
// engine assigns them over each other, so one wins — and the finding exists
// only where the *graph* does not say which.
describe('converging branches', () => {
  const at = (graph) => lintGraph(graph).filter((i) => i.code === 'converging-field')

  const diamond = (extra = {}) => ({
    nodes: [
      node('t1', 'trigger-manual'),
      node('alpha', 'action-http', { url: 'https://a.example.com' }, 'Fetch A'),
      node('beta', 'action-http', { url: 'https://b.example.com' }, 'Fetch B'),
      node('join', 'output-log', { message: 'x' }, 'Log'),
      ...(extra.nodes || []),
    ],
    edges: [
      edge('t1', 'alpha'),
      edge('t1', 'beta'),
      edge('alpha', 'join'),
      edge('beta', 'join'),
      ...(extra.edges || []),
    ],
  })

  it('warns when nothing in the graph decides which branch wins', () => {
    const found = at(diamond())
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].severity).toBe('warning')
    expect(found[0].nodeId).toBe('join')
  })

  it('names both contributors and the field they collide on', () => {
    const found = at(diamond()).find((i) => i.message.includes('"status"'))
    expect(found.message).toMatch(/Fetch A and Fetch B both supply "status"/)
  })

  it('says the winner was picked alphabetically, because that is the whole point', () => {
    const found = at(diamond()).find((i) => i.message.includes('"status"'))
    expect(found.message).toMatch(/Fetch B does, on alphabetical order alone/)
  })

  it('stays silent when the graph does decide', () => {
    // `early → late → join` and `early → join`: late ran after early and saw
    // its value. Predictable from the canvas, so there is nothing to report.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('early', 'action-http', { url: 'https://a.dev' }, 'Early'),
        node('late', 'action-http', { url: 'https://b.dev' }, 'Late'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'early'),
        edge('early', 'late'),
        edge('early', 'join'),
        edge('late', 'join'),
      ],
    }
    expect(at(graph)).toEqual([])
  })

  it('stays silent on the join every canvas has', () => {
    // A condition with both handles wired into one node. Exactly one activates,
    // so nothing is ever assigned over anything.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('check', 'condition', { expression: 'amount > 100' }, 'Large?'),
        node('big', 'action-http', { url: 'https://a.dev' }, 'Big'),
        node('small', 'action-http', { url: 'https://b.dev' }, 'Small'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [
        edge('t1', 'check'),
        edge('check', 'big', 'true'),
        edge('check', 'small', 'false'),
        edge('big', 'join'),
        edge('small', 'join'),
      ],
    }
    expect(at(graph)).toEqual([])
  })

  it('calls out contributors that are differently shaped', () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('alpha', 'transform', { template: '{"id": "abc"}' }, 'A'),
        node('beta', 'transform', { template: '{"id": 7}' }, 'B'),
        node('join', 'output-log', { message: 'x' }, 'Log'),
      ],
      edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
    }
    expect(at(graph)[0].message).toMatch(/differently shaped/)
  })

  it('leaves a graph with no joins completely alone', () => {
    const graph = {
      nodes: [node('t1', 'trigger-manual'), node('a', 'action-http', { url: 'https://x.dev' })],
      edges: [edge('t1', 'a')],
    }
    expect(at(graph)).toEqual([])
  })
})
