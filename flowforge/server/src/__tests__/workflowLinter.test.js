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
