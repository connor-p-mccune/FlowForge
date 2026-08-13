// Collaboration sessions: the live replica, the repair path, and durability.
//
// graphCrdt.test.js proves the merge converges. That is necessary and says
// nothing about a client which never *received* an operation, which is the case
// that used to produce two permanently different canvases and no way to notice.
// These cover the second half: what a reconnecting client is told, and what
// survives every tab closing.

process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
// Persist synchronously on demand rather than on a timer, so the tests assert
// the write itself instead of racing a debounce.
process.env.COLLAB_PERSIST_MS = '0'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const collab = require('../services/collabSession')

const userId = uuidv4()
const workspaceId = uuidv4()

function makeWorkflow(graph = { nodes: [], edges: [] }) {
  const id = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, workspaceId, 'WF', JSON.stringify(graph), userId, now, now)
  return id
}

const storedGraph = (id) =>
  JSON.parse(db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(id).graph_json)

const add = (nodeId, l, s = 'site-a', data = { label: nodeId }) => ({
  t: 'node.add',
  id: nodeId,
  l,
  s,
  node: { type: 'action-http', position: { x: 0, y: 0 }, data },
})
const set = (nodeId, l, s, path, value) => ({ t: 'node.set', id: nodeId, l, s, path, value })

beforeAll(() => {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, 'collab@example.com', 'x', 'Collab', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

describe('loading a session', () => {
  it('seeds from the stored graph', () => {
    const id = makeWorkflow({
      nodes: [{ id: 'h1', type: 'action-http', position: { x: 1, y: 2 }, data: { label: 'Fetch' } }],
      edges: [],
    })
    const result = collab.sync(id, {})
    expect(result.snapshot.nodes).toHaveLength(1)
    expect(result.snapshot.nodes[0].data.label).toBe('Fetch')
    collab.release(id)
  })

  it('returns null for a workflow that no longer exists', () => {
    // Otherwise a socket for a deleted workflow could mint a session whose
    // flush would write the row back into existence.
    expect(collab.sync(uuidv4(), {})).toBeNull()
    expect(collab.applyOps(uuidv4(), [add('n1', 1)])).toBeNull()
  })

  it('survives an unparseable stored graph', () => {
    const id = makeWorkflow()
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?').run('{{ not json', id)
    expect(collab.sync(id, {}).snapshot).toEqual({ nodes: [], edges: [] })
    collab.release(id)
  })
})

describe('applying operations', () => {
  it('reports what changed and what was refused separately', () => {
    const id = makeWorkflow()
    collab.applyOps(id, [add('h1', 5, 'zz', { label: 'Winner' })])
    const result = collab.applyOps(id, [set('h1', 2, 'aa', 'data.label', 'Loser')])

    expect(result.effects).toEqual([])
    expect(result.corrections[0].element.data.label).toBe('Winner')
    collab.release(id)
  })

  it('does not advance the sequence for a batch that changed nothing', () => {
    // A sequence number that moved without a change would make every other
    // client fetch a delta describing nothing.
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 5, 'zz')])
    const second = collab.applyOps(id, [set('h1', 1, 'aa', 'data.label', 'Stale')])
    expect(second.seq).toBe(first.seq)
    collab.release(id)
  })

  it('counts one log entry per element per batch, however often it is edited', () => {
    // A node dragged across the canvas produces hundreds of operations; the
    // delta only ever needs to know *that* it changed.
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 1)])
    collab.applyOps(
      id,
      Array.from({ length: 300 }, (_, i) => set('h1', i + 2, 'site-a', 'position', { x: i, y: i }))
    )
    collab.applyOps(id, [add('h2', 400)])

    const delta = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(delta.changes.map((c) => c.id).sort()).toEqual(['h1', 'h2'])
    collab.release(id)
  })

  it('keeps a delta usable when compaction raises the log’s lowest sequence', () => {
    // Compaction moves an element's record to the end rather than duplicating
    // it, so the log's lowest sequence rises without anything being lost.
    // Reading the delta bound off the log itself would send a snapshot to every
    // client the moment somebody dragged one node repeatedly.
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 1)])
    collab.applyOps(id, [set('h1', 2, 'site-a', 'data.label', 'Second')])
    collab.applyOps(id, [set('h1', 3, 'site-a', 'data.label', 'Third')])

    const delta = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(delta.snapshot).toBeUndefined()
    expect(delta.changes[0].element.data.label).toBe('Third')
    collab.release(id)
  })
})

describe('repairing a client that missed changes', () => {
  it('replies with a delta covering only what changed since', () => {
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 1)])
    collab.applyOps(id, [add('h2', 2)])

    const delta = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(delta.changes.map((c) => c.id)).toEqual(['h2'])
    collab.release(id)
  })

  it('reports the current value, not the value at that sequence', () => {
    // A delta describes where the client should end up, which is what makes
    // replaying it twice harmless.
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 1)])
    collab.applyOps(id, [set('h1', 2, 'site-a', 'data.label', 'Second')])
    collab.applyOps(id, [set('h1', 3, 'site-a', 'data.label', 'Third')])

    const delta = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(delta.changes).toEqual([
      {
        kind: 'node',
        id: 'h1',
        element: {
          id: 'h1',
          type: 'action-http',
          position: { x: 0, y: 0 },
          data: { label: 'Third' },
        },
      },
    ])
    collab.release(id)
  })

  it('reports a removed element as null rather than omitting it', () => {
    // Omitting it would leave the reconnecting client showing a node everybody
    // else deleted — a silent divergence rather than a visible one.
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('h1', 1)])
    collab.applyOps(id, [{ t: 'node.remove', id: 'h1', l: 2, s: 'site-a' }])

    const delta = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(delta.changes).toEqual([{ kind: 'node', id: 'h1', element: null }])
    collab.release(id)
  })

  it('falls back to a snapshot when the log no longer reaches back far enough', () => {
    const id = makeWorkflow()
    const first = collab.applyOps(id, [add('start', 1)])
    for (let i = 0; i < collab.LOG_LIMIT + 10; i++) {
      collab.applyOps(id, [add(`n${i}`, i + 2)])
    }
    const result = collab.sync(id, { epoch: first.epoch, since: first.seq })
    expect(result.snapshot).toBeDefined()
    expect(result.changes).toBeUndefined()
    collab.release(id)
  })

  it('falls back to a snapshot for a client ahead of the session', () => {
    const id = makeWorkflow()
    const applied = collab.applyOps(id, [add('h1', 1)])
    expect(collab.sync(id, { epoch: applied.epoch, since: 99 }).snapshot).toBeDefined()
    collab.release(id)
  })

  it('hands back a lamport the client can beat', () => {
    // A rejoining client has to issue operations that win over what it missed,
    // and its own clock stopped while it was away.
    const id = makeWorkflow()
    collab.applyOps(id, [add('h1', 42, 'someone-else')])
    expect(collab.sync(id, {}).lamport).toBe(42)
    collab.release(id)
  })
})

describe('durability', () => {
  it('persists the merged graph, so a session outlives the tabs that made it', () => {
    const id = makeWorkflow()
    collab.applyOps(id, [add('h1', 1, 'site-a', { label: 'Fetch' })])
    collab.applyOps(id, [
      { t: 'edge.add', id: 'e1', l: 2, s: 'site-a', edge: { source: 'h1', target: 'h1' } },
    ])
    collab.release(id)

    const stored = storedGraph(id)
    expect(stored.nodes.map((n) => n.data.label)).toEqual(['Fetch'])
  })

  it('writes nothing when nothing changed', () => {
    const id = makeWorkflow({ nodes: [{ id: 'x', type: 'note', position: { x: 0, y: 0 }, data: {} }], edges: [] })
    collab.sync(id, {})
    expect(collab.flush(id)).toBe(false)
    collab.release(id)
    // The original row is untouched — not rewritten with a materialised
    // equivalent, which would churn updated_at on every reader.
    expect(storedGraph(id).nodes[0].id).toBe('x')
  })

  it('drops the session on release so the next joiner reads from the row', () => {
    const id = makeWorkflow()
    collab.applyOps(id, [add('h1', 1)])
    collab.release(id)

    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?').run(
      JSON.stringify({ nodes: [{ id: 'other', type: 'note', position: { x: 0, y: 0 }, data: {} }], edges: [] }),
      id
    )
    expect(collab.sync(id, {}).snapshot.nodes.map((n) => n.id)).toEqual(['other'])
    collab.release(id)
  })

  it('flushes every session on the way down', () => {
    const a = makeWorkflow()
    const b = makeWorkflow()
    collab.applyOps(a, [add('in-a', 1)])
    collab.applyOps(b, [add('in-b', 1)])

    collab.flushAll()

    expect(storedGraph(a).nodes.map((n) => n.id)).toEqual(['in-a'])
    expect(storedGraph(b).nodes.map((n) => n.id)).toEqual(['in-b'])
  })
})

describe('invalidation', () => {
  it('discards the session without writing it back', () => {
    // A merge or a version restore has just written the authoritative graph.
    // The session document describes the state *before* that write, so
    // flushing it would undo the merge.
    const id = makeWorkflow()
    collab.applyOps(id, [add('pre-merge', 1)])

    const merged = { nodes: [{ id: 'merged', type: 'note', position: { x: 0, y: 0 }, data: {} }], edges: [] }
    db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?').run(JSON.stringify(merged), id)
    collab.invalidate(id)

    expect(storedGraph(id).nodes.map((n) => n.id)).toEqual(['merged'])
    expect(collab.sync(id, {}).snapshot.nodes.map((n) => n.id)).toEqual(['merged'])
    collab.release(id)
  })

  it('starts a new epoch, so a client from the old one resyncs in full', () => {
    const id = makeWorkflow()
    const before = collab.applyOps(id, [add('h1', 1)])
    collab.invalidate(id)
    const after = collab.sync(id, { epoch: before.epoch, since: before.seq })
    expect(after.epoch).not.toBe(before.epoch)
    expect(after.snapshot).toBeDefined()
    collab.release(id)
  })
})
