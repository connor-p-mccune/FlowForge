// The trust store and signed imports, end to end.
//
// The behaviour worth pinning is not "signatures verify" — artifactSigning.test.js
// covers that — it is the admission policy around them, where the interesting
// decision lives: **a broken signature is refused whether or not this workspace
// requires signing.** Only the *unsigned* case is configuration. Conflating the
// two is what makes signing decorative, so most of this file is about keeping
// them apart.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const db = require('../config/database')
const { app } = require('../index')
const signing = require('../services/artifactSigning')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

const DOCUMENT = {
  exportVersion: '1.0',
  name: 'Promoted sync',
  graph_data: {
    nodes: [node('hook', 'trigger-webhook'), node('charge', 'action-http', { url: 'https://api.acme.com/x', method: 'POST' }, 'Charge')],
    edges: [{ id: 'e1', source: 'hook', target: 'charge' }],
  },
  guarantees: [],
}

const keys = signing.generateKeyPair()
const rogue = signing.generateKeyPair()
const sign = (doc, privateKey = keys.privateKey) => ({
  ...doc,
  signature: signing.signDocument(doc, privateKey),
})

let ownerToken
let memberToken
let apiToken
let workspaceId

const asOwner = (req) => req.set('Authorization', `Bearer ${ownerToken}`)
const asMember = (req) => req.set('Authorization', `Bearer ${memberToken}`)

const auditEntries = (action) =>
  db.prepare('SELECT * FROM audit_log WHERE workspace_id = ? AND action = ? ORDER BY seq')
    .all(workspaceId, action)

beforeAll(async () => {
  const owner = await request(app)
    .post('/api/auth/register')
    .send({ email: 'trust-owner@example.com', password: 'password123', displayName: 'Owner' })
  ownerToken = owner.body.token
  const ws = await asOwner(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id

  const member = await request(app)
    .post('/api/auth/register')
    .send({ email: 'trust-member@example.com', password: 'password123', displayName: 'Member' })
  memberToken = member.body.token
  await asOwner(request(app).post(`/api/workspaces/${workspaceId}/members`)).send({
    email: 'trust-member@example.com',
    role: 'member',
  })

  const minted = await asOwner(request(app).post('/api/tokens')).send({
    name: 'promotion',
    scopes: ['read', 'manage'],
  })
  apiToken = minted.body.token
})

describe('managing the trust store', () => {
  it('trusts a key and audits the fingerprint, not the key', async () => {
    const res = await asOwner(request(app).post(`/api/workspaces/${workspaceId}/signing-keys`)).send({
      name: 'release key',
      publicKey: keys.publicKey,
    })
    expect(res.status).toBe(201)
    expect(res.body.key).toMatchObject({
      name: 'release key',
      fingerprint: keys.fingerprint,
      active: true,
      addedBy: 'Owner',
    })

    const [entry] = auditEntries('signing_key.added')
    expect(JSON.parse(entry.metadata)).toMatchObject({ fingerprint: keys.fingerprint })
  })

  it('refuses anything that is not an ed25519 public key', async () => {
    const post = (body) =>
      asOwner(request(app).post(`/api/workspaces/${workspaceId}/signing-keys`)).send(body)

    expect((await post({ name: 'x', publicKey: 'not a key' })).body.error).toMatch(/valid PEM/)
    expect((await post({ publicKey: keys.publicKey })).body.error).toMatch(/name is required/)
    // An RSA key would verify nothing this system produces, so it is refused at
    // the door rather than stored as a key that never matches.
    const rsa = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect((await post({ name: 'rsa', publicKey: pem })).body.error).toMatch(/ed25519/)
  })

  it('refuses to trust the same key twice under two names', async () => {
    const res = await asOwner(request(app).post(`/api/workspaces/${workspaceId}/signing-keys`)).send({
      name: 'the same key again',
      publicKey: keys.publicKey,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/already trusted/)
  })

  it('is owner-only, and does not confirm the workspace to a stranger', async () => {
    const forbidden = await asMember(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`))
    expect(forbidden.status).toBe(403)

    const stranger = await request(app)
      .post('/api/auth/register')
      .send({ email: 'trust-stranger@example.com', password: 'password123', displayName: 'S' })
    const hidden = await request(app)
      .get(`/api/workspaces/${workspaceId}/signing-keys`)
      .set('Authorization', `Bearer ${stranger.body.token}`)
    expect(hidden.status).toBe(404)
  })
})

describe('an unsigned import', () => {
  it('is allowed while the workspace does not require signing, and records the digest', async () => {
    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(DOCUMENT)
    expect(res.status).toBe(201)
    expect(res.body.provenance).toMatchObject({
      status: 'unsigned',
      required: false,
      digest: signing.digestOf(DOCUMENT),
    })
    // The digest lands in the audit trail even unsigned: "which graph is this"
    // is useful whether or not anybody vouched for it.
    const entries = auditEntries('workflow.imported')
    expect(JSON.parse(entries[entries.length - 1].metadata)).toMatchObject({
      signature: 'unsigned',
      signedBy: null,
      digest: signing.digestOf(DOCUMENT),
    })
  })
})

describe('a signed import', () => {
  it('is accepted and records which key vouched for it', async () => {
    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(sign(DOCUMENT))
    expect(res.status).toBe(201)
    expect(res.body.provenance.status).toBe('trusted')
    expect(res.body.provenance.signedBy).toMatchObject({
      name: 'release key',
      fingerprint: keys.fingerprint,
    })

    const entries = auditEntries('workflow.imported')
    expect(JSON.parse(entries[entries.length - 1].metadata)).toMatchObject({
      signature: 'trusted',
      signedBy: keys.fingerprint,
    })
  })

  it('is refused when the document changed after signing, requirement or not', async () => {
    const tampered = sign(DOCUMENT)
    tampered.graph_data.nodes[1].data.config.url = 'https://evil.example.net/collect'

    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(tampered)
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/modified after signing/)
    expect(res.body.provenance.status).toBe('invalid')
    // Nothing landed.
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE workspace_id = ? AND name = ?')
        .get(workspaceId, tampered.name).n
    ).toBe(2) // the unsigned and the signed imports above, and nothing more
  })

  it('is refused when signed by a key this workspace does not trust', async () => {
    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(sign(DOCUMENT, rogue.privateKey))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/does not trust/)
    expect(res.body.provenance.status).toBe('untrusted')
  })

  it('survives a document reserialised on the way through', async () => {
    // What actually happens in a promotion: the file is written, reformatted,
    // read back, and the canvas moved a node since. None of that is a change to
    // what the workflow does, and none of it may invalidate the approval.
    const signed = sign(DOCUMENT)
    const travelled = {
      ...signed,
      exportedAt: new Date().toISOString(),
      graph_data: {
        nodes: [...signed.graph_data.nodes].reverse().map((n) => ({
          ...n,
          position: { x: 999, y: -12 },
        })),
        edges: [{ id: 'redrawn', source: 'hook', target: 'charge' }],
      },
    }
    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(travelled)
    expect(res.status).toBe(201)
    expect(res.body.provenance.status).toBe('trusted')
  })
})

describe('requiring signatures', () => {
  it('refuses to be enabled before there is a key to trust', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'trust-empty@example.com', password: 'password123', displayName: 'E' })
    const list = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${other.body.token}`)
    const emptyWs = list.body.workspaces[0].id

    const res = await request(app)
      .put(`/api/workspaces/${emptyWs}/signing-keys/enforcement`)
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ requireSignedImports: true })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Trust at least one signing key/)
  })

  it('turns an unsigned import into a refusal, and is audited', async () => {
    const on = await asOwner(
      request(app).put(`/api/workspaces/${workspaceId}/signing-keys/enforcement`)
    ).send({ requireSignedImports: true })
    expect(on.body.requireSignedImports).toBe(true)
    expect(JSON.parse(auditEntries('signing_key.enforcement_changed')[0].metadata)).toEqual({
      requireSignedImports: true,
    })

    const refused = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(DOCUMENT)
    expect(refused.status).toBe(403)
    expect(refused.body.error).toMatch(/requires imports to be signed/)
    expect(refused.body.provenance).toMatchObject({ status: 'unsigned', required: true })

    // …while a signed one still lands.
    const accepted = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(sign(DOCUMENT))
    expect(accepted.status).toBe(201)
  })

  it('applies at the public API too, which is the door a pipeline uses', async () => {
    const refused = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send(DOCUMENT)
    expect(refused.status).toBe(403)
    expect(refused.body.provenance.status).toBe('unsigned')

    const accepted = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/workflows/import`)
      .set('Authorization', `Bearer ${apiToken}`)
      .send(sign(DOCUMENT))
    expect(accepted.status).toBe(201)
    expect(accepted.body.provenance).toMatchObject({
      status: 'trusted',
      required: true,
    })
    const entries = auditEntries('workflow.imported')
    expect(JSON.parse(entries[entries.length - 1].metadata)).toMatchObject({
      signature: 'trusted',
      via: 'api',
    })
  })
})

describe('revocation', () => {
  it('stops the key being accepted from that moment, and keeps the row', async () => {
    const keyId = (await asOwner(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`)))
      .body.keys.find((k) => k.fingerprint === keys.fingerprint).id

    const revoked = await asOwner(
      request(app).delete(`/api/workspaces/${workspaceId}/signing-keys/${keyId}`)
    )
    expect(revoked.status).toBe(200)
    expect(revoked.body.key).toMatchObject({ active: false })
    expect(revoked.body.key.revokedAt).toEqual(expect.any(String))
    expect(auditEntries('signing_key.revoked')).toHaveLength(1)

    // The row survives, because the question after an incident is what this key
    // signed *while it was trusted*.
    const listed = await asOwner(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`))
    expect(listed.body.keys.some((k) => k.fingerprint === keys.fingerprint)).toBe(true)

    // And a document it signed is no longer trusted.
    const res = await asOwner(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send(sign(DOCUMENT))
    expect(res.status).toBe(403)
    expect(res.body.provenance.status).toBe('untrusted')
  })

  it('is idempotent, and 404s for a key that was never here', async () => {
    const keyId = (await asOwner(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`)))
      .body.keys[0].id
    expect((await asOwner(request(app).delete(`/api/workspaces/${workspaceId}/signing-keys/${keyId}`))).status).toBe(200)
    expect((await asOwner(request(app).delete(`/api/workspaces/${workspaceId}/signing-keys/nope`))).status).toBe(404)
  })

  it('re-trusting a revoked key reinstates the one row rather than adding a second', async () => {
    const before = (await asOwner(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`)))
      .body.keys.length
    const res = await asOwner(request(app).post(`/api/workspaces/${workspaceId}/signing-keys`)).send({
      name: 'release key (reissued)',
      publicKey: keys.publicKey,
    })
    expect(res.status).toBe(201)
    expect(res.body.reinstated).toBe(true)
    const after = (await asOwner(request(app).get(`/api/workspaces/${workspaceId}/signing-keys`)))
      .body.keys
    expect(after).toHaveLength(before)
    expect(after.find((k) => k.fingerprint === keys.fingerprint)).toMatchObject({
      active: true,
      name: 'release key (reissued)',
    })
  })
})
