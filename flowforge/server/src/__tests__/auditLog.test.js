// Tamper-evident audit log: the chain, the append-only guarantee, the routes.
//
// The tests that matter here are the adversarial ones. It is easy to write a
// log; the claim being made is that *editing* it is detectable, so most of this
// file is about breaking the chain on purpose and checking that verification
// notices — and notices the right way, since a deleted entry, a reordered one,
// and an edited one are three different findings.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')
const { app } = require('../index')
const db = require('../config/database')
const { recordAudit, verifyChain, GENESIS_HASH, entryHash } = require('../services/auditLog')

// The append-only triggers block UPDATE and DELETE on audit_log — which is the
// point, and also means a tampering test has to get past them first. Dropping
// them is exactly the privileged step the design says an attacker needs; the
// chain is what catches them afterwards, and that is what these helpers set up.
function withTriggersDropped(fn) {
  db.exec('DROP TRIGGER IF EXISTS audit_log_append_only_update')
  db.exec('DROP TRIGGER IF EXISTS audit_log_append_only_delete')
  try {
    return fn()
  } finally {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_log_append_only_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_append_only_delete
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `)
  }
}

describe('the hash chain', () => {
  const ws = 'ws-chain'

  beforeEach(() => {
    withTriggersDropped(() => db.prepare('DELETE FROM audit_log WHERE workspace_id = ?').run(ws))
  })

  it('starts from the genesis hash and links each entry to the last', () => {
    const a = recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'API_KEY', name: 'API_KEY' })
    const b = recordAudit(ws, null, 'secret.updated', { type: 'secret', id: 'API_KEY', name: 'API_KEY' })

    expect(a.seq).toBe(1)
    expect(a.prev_hash).toBe(GENESIS_HASH)
    expect(b.seq).toBe(2)
    expect(b.prev_hash).toBe(a.hash)
    expect(verifyChain(ws)).toMatchObject({ ok: true, entries: 2, head: b.hash })
  })

  it('verifies an empty log vacuously, reporting the genesis head', () => {
    expect(verifyChain(ws)).toMatchObject({ ok: true, entries: 0, head: GENESIS_HASH })
  })

  it('refuses an unrecognised action rather than logging into the void', () => {
    // An allow-list is what lets a reader trust that an absent entry means the
    // thing did not happen, rather than that someone typo'd the action name.
    expect(recordAudit(ws, null, 'secret.exfiltrated', {})).toBeNull()
    expect(verifyChain(ws).entries).toBe(0)
  })

  it('records "system" as the actor when nobody is behind the action', () => {
    const entry = recordAudit(ws, null, 'workflow.paused', { type: 'workflow', id: 'w1', name: 'Sync' })
    expect(entry.actor_label).toBe('system')
  })

  it('detects an entry edited in place', () => {
    recordAudit(ws, null, 'member.invited', { type: 'member', id: 'u1', name: 'Ada' })
    const target = recordAudit(ws, null, 'member.role_changed', {
      type: 'member', id: 'u1', name: 'Ada', metadata: { from: 'viewer', to: 'member' },
    })
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'K', name: 'K' })

    // Quietly promote the record of the promotion: viewer→member becomes
    // viewer→owner. Every other field, including the stored hash, is untouched.
    withTriggersDropped(() =>
      db.prepare('UPDATE audit_log SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ from: 'viewer', to: 'owner' }), target.id)
    )

    const result = verifyChain(ws)
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toMatchObject({ seq: 2, id: target.id, reason: 'hash-mismatch' })
  })

  it('detects an entry deleted from the middle', () => {
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'A', name: 'A' })
    const removed = recordAudit(ws, null, 'secret.deleted', { type: 'secret', id: 'A', name: 'A' })
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'B', name: 'B' })

    withTriggersDropped(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(removed.id))

    const result = verifyChain(ws)
    expect(result.ok).toBe(false)
    // The numbering catches this before any hash does: seq 2 is simply gone.
    expect(result.brokenAt).toMatchObject({ seq: 3, reason: 'sequence-gap' })
  })

  it('detects a forged entry spliced in with a recomputed hash', () => {
    // The sophisticated attempt: rewrite an entry *and* its own hash so the
    // entry is internally consistent. It still fails, because the next entry's
    // prev_hash pins the value the forgery replaced.
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'A', name: 'A' })
    const target = recordAudit(ws, null, 'member.removed', { type: 'member', id: 'u9', name: 'Mallory' })
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'B', name: 'B' })

    const forged = { ...target, target_name: 'Someone Else' }
    withTriggersDropped(() =>
      db.prepare('UPDATE audit_log SET target_name = ?, hash = ? WHERE id = ?')
        .run('Someone Else', entryHash(forged, forged.prev_hash), target.id)
    )

    const result = verifyChain(ws)
    expect(result.ok).toBe(false)
    // Entry 2 now hashes correctly on its own; entry 3 is where it comes apart.
    expect(result.brokenAt).toMatchObject({ seq: 3, reason: 'chain-mismatch' })
  })

  it('survives a full rewrite only by rewriting the whole tail — the stated limit', () => {
    // Documenting the boundary of the guarantee as a test: an attacker who
    // rewrites every subsequent entry produces a self-consistent chain. What
    // gives them away is the *head*, which is why verify returns it for
    // external anchoring.
    recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'A', name: 'A' })
    recordAudit(ws, null, 'member.invited', { type: 'member', id: 'u1', name: 'Ada' })
    const before = verifyChain(ws).head

    withTriggersDropped(() => {
      const rows = db.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq').all(ws)
      let prev = GENESIS_HASH
      for (const row of rows) {
        const rewritten = { ...row, target_name: 'Rewritten', prev_hash: prev }
        const hash = entryHash(rewritten, prev)
        db.prepare('UPDATE audit_log SET target_name = ?, prev_hash = ?, hash = ? WHERE id = ?')
          .run('Rewritten', prev, hash, row.id)
        prev = hash
      }
    })

    expect(verifyChain(ws).ok).toBe(true)
    expect(verifyChain(ws).head).not.toBe(before) // the head moved — the tell
  })
})

describe('append-only enforcement', () => {
  const ws = 'ws-appendonly'

  it('aborts an UPDATE or DELETE at the database level', () => {
    const entry = recordAudit(ws, null, 'secret.created', { type: 'secret', id: 'A', name: 'A' })
    expect(() =>
      db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('secret.deleted', entry.id)
    ).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(entry.id)).toThrow(
      /append-only/
    )
    expect(verifyChain(ws).ok).toBe(true)
  })
})

describe('audit routes', () => {
  let ownerToken
  let memberToken
  let workspaceId

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'audit-owner@example.com', password: 'password123', displayName: 'Owner' })
    ownerToken = owner.body.token
    const ws = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${ownerToken}`)
    workspaceId = ws.body.workspaces[0].id

    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'audit-member@example.com', password: 'password123', displayName: 'Mem' })
    memberToken = other.body.token
    await request(app)
      .post(`/api/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'audit-member@example.com', role: 'member' })
  })

  const asOwner = (req) => req.set('Authorization', `Bearer ${ownerToken}`)

  it('records secret writes and reads them back newest-first', async () => {
    await asOwner(request(app).put(`/api/workspaces/${workspaceId}/secrets/STRIPE_KEY`))
      .send({ value: 'sk_live_example_value' })
    await asOwner(request(app).delete(`/api/workspaces/${workspaceId}/secrets/STRIPE_KEY`))

    const res = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/audit`))
    expect(res.status).toBe(200)
    const actions = res.body.entries.map((e) => e.action)
    expect(actions).toContain('secret.created')
    expect(actions).toContain('secret.deleted')
    // Newest first: the delete outranks the create it followed.
    expect(actions.indexOf('secret.deleted')).toBeLessThan(actions.indexOf('secret.created'))
    // The secret's *value* is nowhere in the log — only that it changed.
    expect(JSON.stringify(res.body)).not.toContain('sk_live_example_value')
  })

  it('records the member invite that set the workspace up', async () => {
    const res = await asOwner(
      request(app).get(`/api/workspaces/${workspaceId}/audit?action=member.*`)
    )
    expect(res.status).toBe(200)
    expect(res.body.entries.some((e) => e.action === 'member.invited')).toBe(true)
  })

  it('verifies the live chain through the endpoint', async () => {
    const res = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/audit/verify`))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.entries).toBeGreaterThan(0)
    expect(res.body.head).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.brokenAt).toBeNull()
  })

  it('reports tampering as a 200 with ok:false, not an error status', async () => {
    // A monitoring probe must read this as "the log is compromised", not as
    // "the endpoint is down" — those page different people.
    const row = db
      .prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq LIMIT 1')
      .get(workspaceId)
    withTriggersDropped(() =>
      db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('workflow.deployed', row.id)
    )

    const res = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/audit/verify`))
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.brokenAt.reason).toBe('hash-mismatch')

    // Put it back so the export tests below see an intact chain.
    withTriggersDropped(() =>
      db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run(row.action, row.id)
    )
  })

  it('exports JSON carrying the chain fields and a verification verdict', async () => {
    const res = await asOwner(
      request(app).get(`/api/workspaces/${workspaceId}/audit/export`)
    )
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-/)
    expect(res.body.verification.ok).toBe(true)
    // Every entry ships its links, so a recipient can re-verify without
    // trusting this server.
    for (const entry of res.body.entries) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(entry.prevHash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('exports CSV with a header row and quoted cells', async () => {
    const res = await asOwner(
      request(app).get(`/api/workspaces/${workspaceId}/audit/export?format=csv`)
    )
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    const [header, ...rows] = res.text.trim().split('\n')
    expect(header).toBe(
      'seq,created_at,action,actor,actor_id,target_type,target_id,target_name,metadata,prev_hash,hash'
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].startsWith('"1"')).toBe(true)
  })

  it('refuses a non-owner member with 403 and a stranger with 404', async () => {
    const asMember = await request(app)
      .get(`/api/workspaces/${workspaceId}/audit`)
      .set('Authorization', `Bearer ${memberToken}`)
    expect(asMember.status).toBe(403)

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'audit-stranger@example.com', password: 'password123', displayName: 'S' })
    const asStranger = await request(app)
      .get(`/api/workspaces/${workspaceId}/audit`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
    expect(asStranger.status).toBe(404)
  })

  it('records a token mint into every workspace the token could act on', async () => {
    await asOwner(request(app).post('/api/tokens')).send({ name: 'ci', scopes: ['read'] })
    const res = await asOwner(
      request(app).get(`/api/workspaces/${workspaceId}/audit?action=token.minted`)
    )
    expect(res.body.entries).toHaveLength(1)
    expect(res.body.entries[0].targetName).toBe('ci')
    // The prefix identifies the token; the token itself is never recorded.
    expect(res.body.entries[0].metadata.prefix).toBeTruthy()
    expect(res.body.entries[0].metadata.scopes).toEqual(['read'])
  })
})
