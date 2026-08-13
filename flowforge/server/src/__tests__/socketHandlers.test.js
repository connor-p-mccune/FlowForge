process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const registerHandlers = require('../socket/handlers')
const collabSession = require('../services/collabSession')

// A workspace with one member, one viewer, an outsider who is NOT a member,
// and one workflow in that workspace — enough to prove join/relay are gated
// on membership and that viewers relay nothing.
const memberId = uuidv4()
const viewerId = uuidv4()
const outsiderId = uuidv4()
const workspaceId = uuidv4()
const workflowId = uuidv4()
const room = `workflow:${workflowId}`

beforeAll(() => {
  const now = new Date().toISOString()
  const user = db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  user.run(memberId, 'member@example.com', 'x', 'Member', now)
  user.run(viewerId, 'viewer@example.com', 'x', 'Viewer', now)
  user.run(outsiderId, 'outsider@example.com', 'x', 'Outsider', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', memberId, now, now)
  const membership = db.prepare(
    'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  )
  membership.run(workspaceId, memberId, 'owner', now)
  membership.run(workspaceId, viewerId, 'viewer', now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(workflowId, workspaceId, 'WF', memberId, now, now)
})

// Minimal fake io for getActiveUsers (presence): no sockets in the adapter, so
// presence resolves to an empty list — these tests only assert join/relay gating.
function makeIo() {
  return { sockets: { adapter: { rooms: new Map() }, sockets: new Map() } }
}

// Fake socket recording handler registrations, room membership, and emits.
function makeSocket(userId) {
  const handlers = {}
  const roomEmits = [] // socket.to(room).emit(event, payload)
  const selfEmits = [] // socket.emit(event, payload)
  const socket = {
    userId,
    displayName: `U-${userId}`,
    color: '#abc',
    rooms: new Set(),
    join(r) {
      this.rooms.add(r)
    },
    leave(r) {
      this.rooms.delete(r)
    },
    emit(event, payload) {
      selfEmits.push({ event, payload })
    },
    to(r) {
      return { emit: (event, payload) => roomEmits.push({ room: r, event, payload }) }
    },
    on(event, fn) {
      handlers[event] = fn
    },
  }
  return { socket, handlers, roomEmits, selfEmits }
}

describe('socket join-workflow authorization', () => {
  it('lets a workspace member join and announces presence', () => {
    const { socket, handlers, roomEmits, selfEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())

    handlers['join-workflow']({ workflowId })

    expect(socket.rooms.has(room)).toBe(true)
    expect(selfEmits.some((e) => e.event === 'presence')).toBe(true)
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'user-joined' }))
    expect(selfEmits.some((e) => e.event === 'workflow-access-denied')).toBe(false)
  })

  it('refuses a non-member: no join, no presence broadcast, explicit denial', () => {
    const { socket, handlers, roomEmits, selfEmits } = makeSocket(outsiderId)
    registerHandlers(socket, makeIo())

    handlers['join-workflow']({ workflowId })

    expect(socket.rooms.has(room)).toBe(false)
    expect(selfEmits).toContainEqual(
      expect.objectContaining({ event: 'workflow-access-denied', payload: { workflowId } })
    )
    expect(roomEmits.some((e) => e.event === 'user-joined')).toBe(false)
  })

  it('refuses an unknown workflow id', () => {
    const { socket, handlers } = makeSocket(memberId)
    registerHandlers(socket, makeIo())

    handlers['join-workflow']({ workflowId: uuidv4() })

    expect([...socket.rooms].some((r) => r.startsWith('workflow:'))).toBe(false)
  })
})

const addOp = (id, l) => ({
  t: 'node.add',
  id,
  l,
  s: 'site-1',
  node: { type: 'action-http', position: { x: 0, y: 0 }, data: { label: id } },
})

describe('graph operations require room membership', () => {
  afterEach(() => collabSession.invalidate(workflowId))

  it('merges an operation only after a successful join', () => {
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())

    // Before joining: dropped. A socket cannot inject into a room it never
    // joined — socket.to(room) would otherwise broadcast regardless.
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 1)] })
    expect(roomEmits.some((e) => e.event === 'graph-effects')).toBe(false)

    handlers['join-workflow']({ workflowId })
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 2)] })
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'graph-effects' }))
  })

  it('broadcasts the merged element, not the operation', () => {
    // The whole point of the server being the convergence point: peers receive
    // a value the merge produced rather than re-deriving one themselves.
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 1)] })

    const broadcast = roomEmits.find((e) => e.event === 'graph-effects')
    expect(broadcast.payload.effects).toEqual([
      {
        kind: 'node',
        id: 'n1',
        element: {
          id: 'n1',
          type: 'action-http',
          position: { x: 0, y: 0 },
          data: { label: 'n1' },
        },
      },
    ])
  })

  it('sends the winning value back to a writer whose operation lost', () => {
    // Without this the sender is the one replica holding a value the merge
    // rejected — diverged on precisely the edit it cared about.
    const winner = makeSocket(memberId)
    registerHandlers(winner.socket, makeIo())
    winner.handlers['join-workflow']({ workflowId })
    winner.handlers['graph-op']({
      workflowId,
      ops: [{ t: 'node.add', id: 'n9', l: 9, s: 'zz', node: { data: { label: 'Winner' } } }],
    })

    const loser = makeSocket(memberId)
    registerHandlers(loser.socket, makeIo())
    loser.handlers['join-workflow']({ workflowId })
    loser.handlers['graph-op']({
      workflowId,
      ops: [{ t: 'node.set', id: 'n9', l: 2, s: 'aa', path: 'data.label', value: 'Loser' }],
    })

    const ack = loser.selfEmits.find((e) => e.event === 'graph-ack')
    expect(ack.payload.corrections[0].element.data.label).toBe('Winner')
    // …and nothing was broadcast, because nothing changed.
    expect(loser.roomEmits.some((e) => e.event === 'graph-effects')).toBe(false)
  })

  it('refuses a malformed operation without discarding the batch', () => {
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })

    handlers['graph-op']({
      workflowId,
      ops: [
        { t: 'node.set', id: 'n1', l: 1, s: 'a', path: 'data.__proto__', value: 1 },
        addOp('good', 3),
      ],
    })

    const effects = roomEmits.find((e) => e.event === 'graph-effects').payload.effects
    expect(effects.map((e) => e.id)).toEqual(['good'])
  })

  it('ignores an oversized batch outright', () => {
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })

    handlers['graph-op']({
      workflowId,
      ops: Array.from({ length: 500 }, (_, i) => addOp(`flood-${i}`, i + 1)),
    })
    expect(roomEmits.some((e) => e.event === 'graph-effects')).toBe(false)
  })

  it('a viewer joins and is seen, but their graph edits are dropped', () => {
    const { socket, handlers, roomEmits } = makeSocket(viewerId)
    registerHandlers(socket, makeIo())

    handlers['join-workflow']({ workflowId })
    expect(socket.rooms.has(room)).toBe(true)
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'user-joined' }))

    // Read-only holds at the socket layer too: operations vanish…
    handlers['graph-op']({ workflowId, ops: [addOp('viewer-node', 1)] })
    expect(roomEmits.some((e) => e.event === 'graph-effects')).toBe(false)

    // …while presence (cursor) still relays — watching is the role.
    handlers['cursor-move']({ workflowId, x: 3, y: 4 })
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'remote-cursor' }))
  })

  it('drops cursor and sync requests from a socket that never joined', () => {
    const { socket, handlers, roomEmits, selfEmits } = makeSocket(outsiderId)
    registerHandlers(socket, makeIo())

    handlers['cursor-move']({ workflowId, x: 1, y: 2 })
    handlers['graph-sync']({ workflowId, since: 0 })

    expect(roomEmits.some((e) => e.event === 'remote-cursor')).toBe(false)
    expect(selfEmits.some((e) => e.event === 'graph-state')).toBe(false)
  })
})

describe('graph-sync repairs a client that missed changes', () => {
  afterEach(() => collabSession.invalidate(workflowId))

  it('hands a never-synced client a snapshot', () => {
    const { socket, handlers, selfEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 1)] })

    handlers['graph-sync']({ workflowId, since: 0 })
    const state = selfEmits.find((e) => e.event === 'graph-state')
    expect(state.payload.snapshot.nodes.map((n) => n.id)).toEqual(['n1'])
  })

  it('hands a client that is only slightly behind a delta', () => {
    const { socket, handlers, selfEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 1)] })
    const ack = selfEmits.find((e) => e.event === 'graph-ack').payload
    handlers['graph-op']({ workflowId, ops: [addOp('n2', 2)] })

    handlers['graph-sync']({ workflowId, epoch: ack.epoch, since: ack.seq })
    const state = selfEmits.filter((e) => e.event === 'graph-state').pop()
    expect(state.payload.snapshot).toBeUndefined()
    expect(state.payload.changes.map((c) => c.id)).toEqual(['n2'])
  })

  it('falls back to a snapshot when the client is from an older session', () => {
    // A restart, or a merge that invalidated the document, starts a new
    // session. A client still holding "I was at 7" would otherwise be handed a
    // delta from 7 and quietly keep state that no longer exists.
    const { socket, handlers, selfEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())
    handlers['join-workflow']({ workflowId })
    handlers['graph-op']({ workflowId, ops: [addOp('n1', 1)] })
    const ack = selfEmits.find((e) => e.event === 'graph-ack').payload

    collabSession.invalidate(workflowId)

    handlers['graph-sync']({ workflowId, epoch: ack.epoch, since: ack.seq })
    const state = selfEmits.filter((e) => e.event === 'graph-state').pop()
    expect(state.payload.snapshot).toBeDefined()
    expect(state.payload.epoch).not.toBe(ack.epoch)
  })
})

describe('socket disconnect announces departure', () => {
  // Regression: must listen on `disconnecting`, not `disconnect`. Socket.io clears
  // socket.rooms before `disconnect` fires, so a `disconnect` handler would iterate
  // an empty set and never broadcast user-left. `disconnecting` still has the rooms.
  it('broadcasts user-left to each joined workflow room on disconnecting', () => {
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())

    expect(typeof handlers['disconnecting']).toBe('function')
    expect(handlers['disconnect']).toBeUndefined()

    handlers['join-workflow']({ workflowId })
    handlers['disconnecting']()

    expect(roomEmits).toContainEqual(
      expect.objectContaining({ room, event: 'user-left', payload: { userId: memberId } })
    )
  })
})
