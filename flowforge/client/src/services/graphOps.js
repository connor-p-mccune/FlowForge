// The client half of the collaboration CRDT (server/src/services/graphCrdt.js).
//
// The browser deliberately does **not** carry the merge. It carries a clock, an
// operation builder, and a queue for while the connection is down; the server
// is the convergence point and hands back merged elements. That split is a
// judgement about what a replica actually is here: a tab is a view that can be
// closed at any moment, while the server is the durable one, so putting the
// authoritative document there means a session's work survives every tab
// closing and a reconnecting client can be told what it missed rather than
// having to reason about it.
//
// What the client owns is the part the server cannot: the Lamport clock. A
// timestamp has to be assigned when the edit is *made*, including while
// offline, or a queued edit would rejoin with a clock from the past and lose to
// changes it should have beaten.

// A site id per tab, not per user: one person with the workflow open twice is
// two replicas, and giving them the same id would make their concurrent edits
// compare equal with no winner.
const siteId =
  (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).slice(0, 24)

export function createClock() {
  return { lamport: 0, siteId }
}

// The send half of the Lamport rule.
export function tick(clock) {
  clock.lamport += 1
  return { l: clock.lamport, s: clock.siteId }
}

// The receive half: stay ahead of everything seen, so the next local edit wins
// against what it was made after. Called on every server message that carries a
// clock, including the reconnect sync — which is what stops a rejoining tab
// from issuing operations that lose to changes made while it was away.
export function observe(clock, lamport) {
  if (Number.isFinite(lamport) && lamport > clock.lamport) clock.lamport = lamport
}

const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype'])

// Expand a node into per-field operations. Field granularity is the point: two
// people editing different config keys of the same node both keep their edit,
// which a per-element comparison could not express.
function fieldOps(id, stamp, patch) {
  const ops = []
  if (patch.position !== undefined) {
    ops.push({ t: 'node.set', id, ...stamp, path: 'position', value: patch.position })
  }
  for (const [key, value] of Object.entries(patch.data || {})) {
    if (UNSAFE_KEY.has(key)) continue
    if (key === 'config') {
      for (const [ck, cv] of Object.entries(value || {})) {
        if (!UNSAFE_KEY.has(ck)) {
          ops.push({ t: 'node.set', id, ...stamp, path: `config.${ck}`, value: cv })
        }
      }
    } else {
      ops.push({ t: 'node.set', id, ...stamp, path: `data.${key}`, value })
    }
  }
  return ops
}

// Build the operations for one local change. `action` matches the canvas's
// existing vocabulary ('add' | 'update' | 'remove') so every call site is
// unchanged — what changed is what goes on the wire.
//
// Every operation in a batch shares one timestamp. They describe a single user
// action, so splitting them across clock values would let another site's edit
// interleave into the middle of one gesture.
export function nodeOps(clock, action, node) {
  if (!node?.id) return []
  const stamp = tick(clock)
  if (action === 'remove') return [{ t: 'node.remove', id: node.id, ...stamp }]
  if (action === 'add') return [{ t: 'node.add', id: node.id, ...stamp, node }]
  return fieldOps(node.id, stamp, node)
}

export function edgeOps(clock, action, edge) {
  if (!edge?.id) return []
  const stamp = tick(clock)
  if (action === 'remove') return [{ t: 'edge.remove', id: edge.id, ...stamp }]
  if (action === 'add') return [{ t: 'edge.add', id: edge.id, ...stamp, edge }]
  return []
}

// Replace the node array from a full snapshot while keeping local view state.
//
// A snapshot is the server saying "here is the document" — it is authoritative
// about the graph and knows nothing about which node this user has selected or
// is dragging. Dropping that would mean a reconnect deselects whatever the
// person was working on, and a snapshot landing mid-drag would teleport the
// node they are holding.
export function reconcileSnapshot(current, incoming) {
  const local = new Map(current.map((node) => [node.id, node]))
  return incoming.map((node) => {
    const mine = local.get(node.id)
    if (!mine) return node
    return {
      ...node,
      ...(mine.selected ? { selected: true } : {}),
      ...(mine.dragging ? { dragging: true, position: mine.position } : {}),
    }
  })
}

// Merge a server effect into a React Flow element array. `element: null` means
// the element is gone — reported rather than omitted, so a client that missed
// the delete finds out instead of quietly keeping a node nobody else has.
export function applyEffect(list, effect) {
  const index = list.findIndex((item) => item.id === effect.id)
  if (effect.element === null) {
    return index === -1 ? list : list.filter((item) => item.id !== effect.id)
  }
  if (index === -1) return [...list, effect.element]
  const next = [...list]
  // Local-only view state (selection, drag flags) is not part of the document
  // and must survive a remote edit — having somebody else's rename clear your
  // selection is exactly the kind of thing that makes shared editing feel
  // hostile.
  const { selected, dragging } = next[index]
  next[index] = { ...effect.element, ...(selected ? { selected } : {}), ...(dragging ? { dragging } : {}) }
  return next
}
