// Per-workflow collaboration sessions: the live replica of a graph being
// edited, the change log that repairs a client which missed something, and the
// write that makes a session's work outlive the tabs that produced it.
//
// `graphCrdt.js` supplies convergence — apply the same operations in any order
// and get the same document. That is necessary and not sufficient: it says
// nothing about a client that never *received* an operation. A dropped Wi-Fi
// connection used to produce permanent divergence, because rejoining the room
// subscribed to future changes and reconciled none of the missed ones. Two
// canvases stayed different until somebody pressed reload and never knew why.
//
// So the session keeps a bounded log of **which elements changed at which
// sequence number**, not of the operations themselves. A client reports the
// last sequence it saw and gets back the *current value* of everything touched
// since — a state delta rather than an operation replay. That is deliberately
// the weaker mechanism, and it is the right one here: a delta is correct
// however far behind the client is and however the log was truncated, it
// cannot double-apply, and its size is bounded by the number of distinct
// elements edited rather than by how long the client was away. When the log no
// longer reaches back far enough, the answer is a snapshot rather than an
// error.
//
// **The session is authoritative for a room's lifetime.** The REST graph save
// still runs — it is what a client with no socket uses — but it does not reset
// the session, because it carries a state the session already agrees with. What
// *does* reset it is a graph replaced wholesale from outside the room: a
// three-way merge, a version restore, an import. Those are a new baseline
// rather than a concurrent edit, and treating them as one would let a session
// quietly write the pre-merge graph back over the merged one.

const db = require('../config/database')
const { docFromGraph, applyOp, materialize, materializeOne } = require('./graphCrdt')

// How many change records to keep per session. A client that reconnects within
// this many edits gets a delta; one further behind gets a snapshot. 500 covers
// a long editing session and costs a few KB.
const LOG_LIMIT = 500

const PERSIST_DEBOUNCE_MS = (() => {
  const raw = Number(process.env.COLLAB_PERSIST_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000
})()

const sessions = new Map()

function parseGraph(json) {
  try {
    const parsed = JSON.parse(json)
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

// Load (or reuse) the session for a workflow. Returns null for a workflow that
// no longer exists, so a socket for a deleted workflow can't mint a session
// that would later write a row back into existence.
function sessionFor(workflowId) {
  const existing = sessions.get(workflowId)
  if (existing) return existing

  const row = db.prepare('SELECT graph_json FROM workflows WHERE id = ?').get(workflowId)
  if (!row) return null

  const session = {
    workflowId,
    // A sequence number only means something *within* one session. A server
    // restart, or a merge that invalidated the document, starts a new one — and
    // a client still holding "I was at 7" from the old session would otherwise
    // be handed a delta from 7 and quietly keep state that no longer exists.
    // The epoch makes that mismatch explicit instead of plausible.
    epoch: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    doc: docFromGraph(parseGraph(row.graph_json)),
    seq: 0,
    log: [], // [{ seq, kind, id }] — what changed, not how
    // The highest sequence whose record has been evicted by the log cap. This,
    // not the log's lowest sequence, is what bounds a usable delta: the log
    // compacts an element edited twice into one record at the later sequence,
    // which raises the lowest sequence without losing anything. Reading the
    // bound off the log itself would send a snapshot to every client the moment
    // somebody dragged a node.
    trimmedThrough: 0,
    dirty: false,
    timer: null,
  }
  sessions.set(workflowId, session)
  return session
}

function schedulePersist(session) {
  if (session.timer || PERSIST_DEBOUNCE_MS === 0) return
  session.timer = setTimeout(() => {
    session.timer = null
    flush(session.workflowId)
  }, PERSIST_DEBOUNCE_MS)
  // Never hold the process open for a debounce — graceful shutdown drains
  // in-flight runs, not editor state, and `release` already flushes.
  session.timer.unref?.()
}

// Apply a batch of operations from one client.
//
// Returns two lists because a losing writer needs different information from
// everybody else. `effects` are the elements that actually changed and go to
// the rest of the room. `corrections` are elements whose registers refused the
// operation — the sender applied it optimistically and is now the only replica
// holding a value the merge rejected, so it gets the winning one back. Without
// this the sender diverges permanently on exactly the operation it cared most
// about.
function applyOps(workflowId, ops) {
  const session = sessionFor(workflowId)
  if (!session) return null

  const effects = []
  const corrections = []
  const touched = new Set()

  for (const op of ops) {
    const result = applyOp(session.doc, op)
    if (!result.kind) continue
    const entry = { kind: result.kind, id: result.id, element: result.element }
    if (result.changed) {
      const dedupe = `${entry.kind}:${entry.id}`
      if (!touched.has(dedupe)) touched.add(dedupe)
      effects.push(entry)
    } else {
      corrections.push(entry)
    }
  }

  if (effects.length > 0) {
    session.seq += 1
    for (const key of touched) {
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
      // One record per element per batch, newest last — the delta only ever
      // needs the *set* of ids, so an element edited a thousand times costs one
      // entry rather than a thousand.
      const at = session.log.findIndex((e) => e.kind === kind && e.id === id)
      if (at !== -1) session.log.splice(at, 1)
      session.log.push({ seq: session.seq, kind, id })
    }
    if (session.log.length > LOG_LIMIT) {
      const evicted = session.log.splice(0, session.log.length - LOG_LIMIT)
      session.trimmedThrough = Math.max(session.trimmedThrough, evicted[evicted.length - 1].seq)
    }
    session.dirty = true
    schedulePersist(session)
  }

  return {
    effects,
    corrections,
    epoch: session.epoch,
    seq: session.seq,
    lamport: session.doc.lamport,
  }
}

// What a (re)joining client needs to be up to date.
//
// A delta is only offered when it is *provably* sufficient: the client is
// reporting a position in this same session, and the log still reaches back
// that far. Every other case — never synced, a different session generation, a
// log that has been truncated past the client's position — answers with a
// snapshot, which is always correct and merely larger. Guessing wrong here does
// not produce an error, it produces two canvases that disagree forever, so the
// bias is deliberate.
function sync(workflowId, { epoch, since } = {}) {
  const session = sessionFor(workflowId)
  if (!session) return null

  const usable =
    epoch === session.epoch &&
    Number.isInteger(since) &&
    since >= 0 &&
    since <= session.seq &&
    since >= session.trimmedThrough

  if (!usable) {
    return {
      epoch: session.epoch,
      seq: session.seq,
      lamport: session.doc.lamport,
      snapshot: materialize(session.doc),
    }
  }

  const changes = []
  for (const entry of session.log) {
    if (entry.seq <= since) continue
    const map = entry.kind === 'node' ? session.doc.nodes : session.doc.edges
    const rec = map.get(entry.id)
    // The *current* value, not the value at that sequence — a delta describes
    // where the client should end up, so replaying it twice is harmless.
    const element = rec?.exists?.value ? materializeOne(entry.kind, entry.id, rec) : null
    changes.push({ kind: entry.kind, id: entry.id, element })
  }
  return { epoch: session.epoch, seq: session.seq, lamport: session.doc.lamport, changes }
}

// Write the session's graph back to the workflow row. Idempotent and cheap when
// nothing changed, so it is safe to call from the debounce, from room-empty,
// and from a test that wants determinism.
function flush(workflowId) {
  const session = sessions.get(workflowId)
  if (!session || !session.dirty) return false
  const graph = materialize(session.doc)
  const changed = db
    .prepare('UPDATE workflows SET graph_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(graph), new Date().toISOString(), workflowId)
  session.dirty = false
  return changed.changes > 0
}

// The last collaborator left. Persist and drop: holding a document for an empty
// room would keep every workflow ever opened resident for the process's
// lifetime, and the next joiner reads the same state back from the row.
function release(workflowId) {
  const session = sessions.get(workflowId)
  if (!session) return
  if (session.timer) {
    clearTimeout(session.timer)
    session.timer = null
  }
  flush(workflowId)
  sessions.delete(workflowId)
}

// A graph replaced from outside the room — a merge, a version restore, an
// import. Drop the session so the next operation applies on top of the new
// baseline instead of the session writing the pre-merge graph back over it.
function invalidate(workflowId) {
  const session = sessions.get(workflowId)
  if (!session) return
  if (session.timer) clearTimeout(session.timer)
  // Deliberately *not* flushed: the caller has just written the authoritative
  // graph, and this document describes the state before that write.
  sessions.delete(workflowId)
}

// Persist everything on the way down, so a deploy doesn't lose the last few
// seconds of everybody's editing.
function flushAll() {
  for (const workflowId of [...sessions.keys()]) release(workflowId)
}

module.exports = {
  sessionFor,
  applyOps,
  sync,
  flush,
  release,
  invalidate,
  flushAll,
  LOG_LIMIT,
}
