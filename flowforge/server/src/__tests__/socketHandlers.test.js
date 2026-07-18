process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const registerHandlers = require('../socket/handlers')

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

describe('socket relay events require room membership', () => {
  it('relays node-change only after a successful join', () => {
    const { socket, handlers, roomEmits } = makeSocket(memberId)
    registerHandlers(socket, makeIo())

    // Before joining: the relay is dropped (a socket cannot inject into a room
    // it never joined — socket.to(room) would otherwise broadcast regardless).
    handlers['node-change']({ workflowId, action: 'update', node: { id: 'n1' }, ts: 1 })
    expect(roomEmits.some((e) => e.event === 'remote-node')).toBe(false)

    // After joining: the same event is relayed to the room.
    handlers['join-workflow']({ workflowId })
    handlers['node-change']({ workflowId, action: 'update', node: { id: 'n1' }, ts: 2 })
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'remote-node' }))
  })

  it('a viewer joins and is seen, but their graph edits are dropped', () => {
    const { socket, handlers, roomEmits } = makeSocket(viewerId)
    registerHandlers(socket, makeIo())

    handlers['join-workflow']({ workflowId })
    expect(socket.rooms.has(room)).toBe(true)
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'user-joined' }))

    // Read-only holds at the socket layer too: node/edge events vanish…
    handlers['node-change']({ workflowId, action: 'update', node: { id: 'n1' }, ts: 1 })
    handlers['edge-change']({ workflowId, action: 'add', edge: { id: 'e1' }, ts: 1 })
    expect(roomEmits.some((e) => e.event === 'remote-node')).toBe(false)
    expect(roomEmits.some((e) => e.event === 'remote-edge')).toBe(false)

    // …while presence (cursor) still relays — watching is the role.
    handlers['cursor-move']({ workflowId, x: 3, y: 4 })
    expect(roomEmits).toContainEqual(expect.objectContaining({ room, event: 'remote-cursor' }))
  })

  it('drops cursor/edge events from a socket that never joined', () => {
    const { socket, handlers, roomEmits } = makeSocket(outsiderId)
    registerHandlers(socket, makeIo())

    handlers['cursor-move']({ workflowId, x: 1, y: 2 })
    handlers['edge-change']({ workflowId, action: 'add', edge: { id: 'e1' }, ts: 1 })

    expect(roomEmits.some((e) => e.event === 'remote-cursor')).toBe(false)
    expect(roomEmits.some((e) => e.event === 'remote-edge')).toBe(false)
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
