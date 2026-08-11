// Tamper-evident audit log.
//
// FlowForge already has an activity feed, and this is deliberately not it. The
// two answer different questions for different readers:
//
//   activity_events  "what has been happening in this workspace?" — for people,
//                    on a dashboard. It coalesces bursts, carries display
//                    copy, and is a product surface.
//   audit_log        "who changed security-relevant state, when, and can we
//                    prove this record hasn't been edited?" — for an auditor,
//                    an incident review, or a compliance questionnaire.
//
// Everything below follows from the second question, and specifically from the
// last clause of it. A log is only evidence if altering it is detectable, so
// each workspace's entries form a **hash chain**:
//
//   hash(n) = SHA-256( canonical(entry n) || hash(n-1) )
//
// Changing any field of any entry changes its hash, which breaks every entry
// after it. Removing an entry breaks the chain at the join *and* leaves a gap
// in `seq`, which is a contiguous per-workspace counter — so an attacker who
// recomputes the hashes still has to explain a missing sequence number, and one
// who preserves the numbering still has to produce hashes they can't forge
// without rewriting the entire tail.
//
// That is a real but bounded guarantee, and worth stating precisely: a hash
// chain proves **internal consistency**, not third-party notarisation. Someone
// with write access to the database and the ability to rewrite every subsequent
// entry can produce a self-consistent forged chain. What it defeats is the
// realistic case — a targeted edit or deletion of individual entries, which is
// what covering one's tracks actually looks like — and it does so cheaply,
// without an external service. (Anchoring the head hash somewhere out of reach
// would close the remaining gap; the head is exposed by `verifyChain` precisely
// so that a deployment can.)
//
// Writes are additionally append-only *in the schema*: BEFORE UPDATE and BEFORE
// DELETE triggers on audit_log abort the statement. Application code never
// rewrites an entry, but the trigger makes that a property of the database
// rather than a habit of the code.

const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')

// The chain's fixed point: what prev_hash is for the first entry in a
// workspace. All-zero rather than a hash of nothing, so a genesis entry is
// visually obvious in an export.
const GENESIS_HASH = '0'.repeat(64)

// The actions worth recording. An allow-list rather than a free-form string
// because an audit log's value depends on a reader knowing what it *should*
// contain — an unrecognised action is a bug (a typo'd call site logging into
// the void), so recordAudit throws on one rather than silently accepting it.
//
// The set is scoped to governance: credentials, membership, and the operations
// that change what runs in production. Ordinary authoring (renaming a workflow,
// dragging a node) belongs in the activity feed and would only dilute this.
const ACTIONS = new Set([
  // Credentials and configuration a compromise would target.
  'secret.created',
  'secret.updated',
  'secret.deleted',
  'variable.created',
  'variable.updated',
  'variable.deleted',
  // Who can act on the workspace at all.
  'member.invited',
  'member.removed',
  'member.role_changed',
  // Credentials minted outside the browser session.
  'token.minted',
  'token.revoked',
  // What is live, and whether it is allowed to run.
  'workflow.deployed',
  'workflow.deleted',
  'workflow.paused',
  'workflow.resumed',
  'workflow.imported',
  'workflow.merged',
  'workflow.version_restored',
  // Governance rules — and, crucially, their removal. A policy quietly
  // disabled the day before a bad deploy is exactly what an incident review
  // needs to be able to see.
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.overridden',
  // Deliberate faults. "Why did the 3am runs fail?" has a much better answer
  // when the record shows someone armed a chaos profile at 2:50 — and a much
  // worse one when nothing recorded it.
  'chaos.armed',
  'chaos.disarmed',
  // Manually unwinding a run. Compensations fire real, irreversible side
  // effects at real systems — a refund, a release, a deletion — and unlike the
  // automatic rollback there is a person who decided to run them. That decision
  // belongs in the record beside the deploys and the pauses.
  'execution.rolled_back',
  // Surfaces that publish workspace state to people without accounts.
  'status_page.enabled',
  'status_page.rotated',
  'status_page.disabled',
])

// Canonical serialisation of an entry's covered fields.
//
// JSON.stringify over a fixed-order array is the whole trick: it is
// deterministic (no key ordering to depend on), and its escaping means no
// field's contents can imitate a field boundary — a target_name of
// `","action":"secret.deleted` is just a string with quotes in it, not a way to
// shift the meaning of the digest. Every field the reader is asked to trust is
// covered; `id` is not, because it is a random surrogate that carries no claim.
function canonicalize(entry) {
  return JSON.stringify([
    entry.workspace_id,
    entry.seq,
    entry.actor_id ?? null,
    entry.actor_label ?? null,
    entry.action,
    entry.target_type ?? null,
    entry.target_id ?? null,
    entry.target_name ?? null,
    entry.metadata ?? null,
    entry.created_at,
  ])
}

// hash(n) = SHA-256( canonical(n) || hash(n-1) ). Exported so the verifier and
// the writer can never drift into computing it two different ways.
function entryHash(entry, prevHash) {
  return crypto.createHash('sha256').update(canonicalize(entry)).update(prevHash).digest('hex')
}

// The newest entry in a workspace's chain, or null before the first write.
function chainHead(workspaceId) {
  return (
    db
      .prepare('SELECT seq, hash FROM audit_log WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1')
      .get(workspaceId) || null
  )
}

// Append one entry and return it.
//
// Reading the head and inserting the successor must be one atomic step, or two
// concurrent writers could mint the same seq (the UNIQUE constraint would catch
// that) or chain off the same prev_hash (it would not). better-sqlite3 is
// synchronous, so a db.transaction() gives exactly that atomicity within the
// process — the same reasoning the concurrency gate's enqueue check relies on.
//
// Best-effort at the boundary, like activityService: a failure here is logged
// and swallowed rather than propagated, because refusing to delete a secret
// because its audit entry could not be written would turn an observability
// fault into an outage. The gap that leaves is deliberate and visible: a missing
// entry cannot be forged into place later, since every subsequent hash already
// chains past where it would have gone.
function recordAudit(workspaceId, actorId, action, target = {}) {
  try {
    if (!workspaceId) throw new Error('workspaceId is required')
    if (!ACTIONS.has(action)) throw new Error(`unknown audit action "${action}"`)

    const actor = actorId
      ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(actorId)
      : null

    const write = db.transaction(() => {
      const head = chainHead(workspaceId)
      const entry = {
        id: uuidv4(),
        workspace_id: workspaceId,
        seq: head ? head.seq + 1 : 1,
        actor_id: actorId ?? null,
        // 'system' covers the scheduler, the maintenance sweep, and anything
        // else acting without a user behind it — an audit entry always names
        // someone, even if that someone is the platform.
        actor_label: actor ? actor.display_name : actorId ? null : 'system',
        action,
        target_type: target.type ?? null,
        target_id: target.id ?? null,
        target_name: target.name ?? null,
        metadata: target.metadata != null ? JSON.stringify(target.metadata) : null,
        created_at: new Date().toISOString(),
        prev_hash: head ? head.hash : GENESIS_HASH,
      }
      entry.hash = entryHash(entry, entry.prev_hash)

      db.prepare(
        `INSERT INTO audit_log
           (id, workspace_id, seq, actor_id, actor_label, action, target_type, target_id,
            target_name, metadata, created_at, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id, entry.workspace_id, entry.seq, entry.actor_id, entry.actor_label,
        entry.action, entry.target_type, entry.target_id, entry.target_name,
        entry.metadata, entry.created_at, entry.prev_hash, entry.hash
      )
      return entry
    })

    return write()
  } catch (err) {
    console.error('auditLog.recordAudit failed:', err.message)
    return null
  }
}

// Walk a workspace's chain oldest-first and report the first divergence.
//
// Three distinct failures are worth telling apart, because they point at
// different things having happened:
//
//   'sequence-gap'    an entry was deleted (or never committed). The numbering
//                     itself is the witness, independent of any hash.
//   'chain-mismatch'  this entry's prev_hash isn't the previous entry's hash —
//                     entries were removed, reordered, or spliced in.
//   'hash-mismatch'   this entry's own contents no longer produce its stored
//                     hash: a field was edited in place.
//
// Returns { ok, entries, head, brokenAt } where head is the newest hash — the
// value a deployment would anchor externally to close the last gap in the
// guarantee (see the file header).
function verifyChain(workspaceId) {
  const rows = db
    .prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq ASC')
    .all(workspaceId)

  let prevHash = GENESIS_HASH
  let expectedSeq = 1

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        entries: rows.length,
        head: null,
        brokenAt: {
          seq: row.seq,
          id: row.id,
          reason: 'sequence-gap',
          detail: `expected sequence ${expectedSeq}, found ${row.seq}`,
        },
      }
    }
    if (row.prev_hash !== prevHash) {
      return {
        ok: false,
        entries: rows.length,
        head: null,
        brokenAt: {
          seq: row.seq,
          id: row.id,
          reason: 'chain-mismatch',
          detail: 'this entry does not link to the one before it',
        },
      }
    }
    if (entryHash(row, row.prev_hash) !== row.hash) {
      return {
        ok: false,
        entries: rows.length,
        head: null,
        brokenAt: {
          seq: row.seq,
          id: row.id,
          reason: 'hash-mismatch',
          detail: 'this entry’s contents no longer match its recorded hash',
        },
      }
    }
    prevHash = row.hash
    expectedSeq++
  }

  return {
    ok: true,
    entries: rows.length,
    // An empty log verifies — vacuously, and honestly. Reporting the genesis
    // value as the head keeps the "anchor this somewhere" story uniform.
    head: rows.length > 0 ? prevHash : GENESIS_HASH,
    brokenAt: null,
  }
}

// A page of entries, newest first. Keyset-paginated on seq (a strict total
// order within a workspace, unlike a timestamp, which can tie) — `before` is
// the seq of the oldest row already seen.
function listAudit(workspaceId, { limit = 50, before = null, action = null } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200))
  const clauses = ['workspace_id = ?']
  const params = [workspaceId]
  if (before != null && Number.isFinite(Number(before))) {
    clauses.push('seq < ?')
    params.push(Number(before))
  }
  // A trailing '*' matches an action family ('secret.*'), mirroring the
  // activity feed's own filter syntax so one mental model covers both.
  if (typeof action === 'string' && action.trim() !== '') {
    const filter = action.trim()
    if (filter.endsWith('*')) {
      clauses.push('action LIKE ?')
      params.push(`${filter.slice(0, -1)}%`)
    } else {
      clauses.push('action = ?')
      params.push(filter)
    }
  }
  return db
    .prepare(
      `SELECT * FROM audit_log WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`
    )
    .all(...params, capped)
}

module.exports = {
  ACTIONS,
  GENESIS_HASH,
  recordAudit,
  verifyChain,
  listAudit,
  chainHead,
  entryHash,
  canonicalize,
}
