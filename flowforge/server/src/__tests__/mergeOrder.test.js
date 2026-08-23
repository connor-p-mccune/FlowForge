// A node's input is `Object.assign` over its active upstream outputs, which is
// last-writer-wins. These tests pin *who wins* — and, more importantly, pin that
// the answer does not depend on how the graph was stored.
//
// It used to. The engine read the edges in array order, and three different
// parts of the product rewrite that order differently: a collaborative session
// persists `materialize()`, which sorts edges by id; the `.flow` format and the
// artifact signature sort by source/target; a plain save keeps the array as the
// author drew it. So the same graph could compute a different value depending on
// which door it came through, with every static check green — the type checker
// least of all able to see it, because `mergeAssign` soundly *joins* the two
// colliding field types into a union and thereby discards which one you get.
//
// The permutation test below is the one that matters: every ordering of the same
// edge set, one answer.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const { contributionOrder, depths } = require('../services/convergence')

function seedWorkflow(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)

  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return execId
}

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

// Run and return the join node's recorded input.
async function inputAtJoin(graph, joinId = 'join') {
  const execId = seedWorkflow(graph)
  await runExecution(execId, { publish: () => {} })
  const step = db
    .prepare('SELECT input_json FROM execution_steps WHERE execution_id = ? AND node_id = ?')
    .get(execId, joinId)
  return JSON.parse(step.input_json)
}

function permutations(items) {
  if (items.length <= 1) return [items]
  const out = []
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([item, ...tail])
  })
  return out
}

// Two branches that both produce `winner`, converging on one node.
const CONTENDED = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('alpha', 'transform', { template: '{"winner": "alpha", "onlyA": 1}' }),
    node('beta', 'transform', { template: '{"winner": "beta", "onlyB": 2}' }),
    node('join', 'output-log', { message: 'x' }),
  ],
  edges: [edge('t1', 'alpha'), edge('t1', 'beta'), edge('alpha', 'join'), edge('beta', 'join')],
}

describe('merge order at a converging node', () => {
  it('gives one answer for every ordering of the same edges', async () => {
    const seen = new Set()
    for (const edges of permutations(CONTENDED.edges)) {
      const input = await inputAtJoin({ ...CONTENDED, edges })
      seen.add(JSON.stringify(input))
    }
    // 24 orderings of four edges — one merged input. Before the merge order was
    // derived from the graph this produced two, and which one you got depended
    // on whether the graph was last written by a collab session, a plain save,
    // or an import of its own signed export.
    expect([...seen]).toHaveLength(1)
  })

  it('still merges the fields that do not collide', async () => {
    expect(await inputAtJoin(CONTENDED)).toMatchObject({ onlyA: 1, onlyB: 2 })
  })

  it('breaks a tie between concurrent branches the way the document reads', async () => {
    // Neither branch is downstream of the other, so the graph does not say which
    // is fresher and something arbitrary has to decide. That something is the
    // canonical edge sort — the same key the `.flow` format and the artifact
    // signature use — so the order a reviewer reads the document in is the order
    // the engine applies. Here that is alphabetical: beta lands after alpha.
    expect((await inputAtJoin(CONTENDED)).winner).toBe('beta')
  })

  it('lets a downstream contributor override an upstream one', async () => {
    // `early → late → join` and `early → join`. `late` ran after `early` and saw
    // its value, so `late` supersedes it — which is what the canvas looks like
    // it means, and is *not* what alphabetical order would pick.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('early', 'transform', { template: '{"stage": "early"}' }),
        node('late', 'transform', { template: '{"stage": "late"}' }),
        node('join', 'output-log', { message: 'x' }),
      ],
      edges: [
        edge('t1', 'early'),
        edge('early', 'late'),
        edge('early', 'join'),
        edge('late', 'join'),
      ],
    }
    expect((await inputAtJoin(graph)).stage).toBe('late')
  })

  it('reverses nothing when the deeper branch is alphabetically first', async () => {
    // The same shape with the names swapped, so dataflow order and alphabetical
    // order disagree. Dataflow wins: depth is checked before the tie-break.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('zed', 'transform', { template: '{"stage": "shallow"}' }),
        node('abe', 'transform', { template: '{"stage": "deep"}' }),
        node('join', 'output-log', { message: 'x' }),
      ],
      edges: [
        edge('t1', 'zed'),
        edge('zed', 'abe'),
        edge('zed', 'join'),
        edge('abe', 'join'),
      ],
    }
    expect((await inputAtJoin(graph)).stage).toBe('deep')
  })

  it('leaves a trigger payload underneath its own upstream outputs', async () => {
    // The trigger payload is the base of the assign, so a node that produces the
    // same key still overrides it. Unchanged by any of this; pinned because the
    // sort now runs over the same list.
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('mid', 'transform', { template: '{"source": "node"}' }),
        node('join', 'output-log', { message: 'x' }),
      ],
      edges: [edge('t1', 'mid'), edge('mid', 'join')],
    }
    expect((await inputAtJoin(graph)).source).toBe('node')
  })
})

describe('contributionOrder', () => {
  const nodes = ['t1', 'a', 'b', 'c'].map((id) => node(id, 'transform'))

  it('ranks by longest path, so an ancestor never outranks its descendant', () => {
    const edges = [edge('t1', 'a'), edge('a', 'b'), edge('t1', 'b')]
    const depth = depths(nodes, edges)
    // b is reachable from a, so its longest path is strictly longer — which is
    // the property that makes depth a safe key: sorting by it always puts an
    // ancestor first, whatever the tie-break does.
    expect(depth.get('b')).toBeGreaterThan(depth.get('a'))
  })

  it('is a total order, so sorting is deterministic', () => {
    const edges = [edge('a', 'c'), edge('b', 'c')]
    const order = contributionOrder(nodes, edges)
    expect(order(edges[0], edges[1])).toBeLessThan(0)
    expect(order(edges[1], edges[0])).toBeGreaterThan(0)
    expect(order(edges[0], edges[0])).toBe(0)
  })

  it('separates two edges that differ only by handle', () => {
    const order = contributionOrder(nodes, [])
    const yes = edge('a', 'c', 'true')
    const no = edge('a', 'c', 'false')
    expect(order(no, yes)).toBeLessThan(0)
  })

  it('falls back to a stable order on a cyclic graph rather than inventing depths', () => {
    // The engine refuses to run a cycle, so there is no dataflow order to have.
    // Every depth is zero and the canonical sort carries it — still total.
    const edges = [edge('a', 'b'), edge('b', 'a')]
    const depth = depths(nodes, edges)
    expect(depth.get('a')).toBe(0)
    expect(depth.get('b')).toBe(0)
  })
})
