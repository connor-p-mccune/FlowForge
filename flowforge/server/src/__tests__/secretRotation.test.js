// Key rotation through the HTTP surface.
//
// secretVault.test.js proves the cryptography; this proves the operation is one
// somebody can actually run: it reports honestly what moved, every secret still
// decrypts to the same value afterwards, running it twice is a no-op, and a key
// retired too early is reported per secret rather than taking down the sweep.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { decryptSecret, keyIdOf } = require('../services/secretVault')

const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)

let ownerToken
let memberToken
let workspaceId

const setRing = (ring, active) => {
  if (ring === null) delete process.env.SECRETS_KEY_RING
  else process.env.SECRETS_KEY_RING = ring
  if (active === null) delete process.env.SECRETS_ACTIVE_KEY
  else process.env.SECRETS_ACTIVE_KEY = active
}

const putSecret = (name, value) =>
  authed(request(app).put(`/api/workspaces/${workspaceId}/secrets/${name}`).send({ value }), ownerToken)
const rotate = (token = ownerToken) =>
  authed(request(app).post(`/api/workspaces/${workspaceId}/secrets/rotate`), token)
const keys = (token = ownerToken) =>
  authed(request(app).get(`/api/workspaces/${workspaceId}/secrets/keys`), token)

const storedValue = (name) =>
  db
    .prepare('SELECT value_encrypted FROM workspace_secrets WHERE workspace_id = ? AND name = ?')
    .get(workspaceId, name).value_encrypted

beforeAll(async () => {
  const owner = await request(app)
    .post('/api/auth/register')
    .send({ email: `rot-${uuidv4()}@example.com`, password: 'password123', displayName: 'Owner' })
  ownerToken = owner.body.token
  workspaceId = (await authed(request(app).get('/api/workspaces'), ownerToken)).body.workspaces[0].id

  const member = await request(app)
    .post('/api/auth/register')
    .send({ email: `mem-${uuidv4()}@example.com`, password: 'password123', displayName: 'Member' })
  memberToken = member.body.token
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(
    workspaceId,
    member.body.user.id
  )
})

afterEach(() => setRing(null, null))

describe('the key report', () => {
  it('names the active key and flags nothing stale on a fresh workspace', async () => {
    setRing('k1:material-one', 'k1')
    await putSecret('FRESH_KEY', 'sk-fresh')

    const res = await keys()
    expect(res.status).toBe(200)
    expect(res.body.activeKeyId).toBe('k1')
    expect(res.body.secrets).toContainEqual({ name: 'FRESH_KEY', keyId: 'k1', stale: false })
    expect(res.body.stale).toBe(0)
  })

  it('flags a secret left on an older key', async () => {
    setRing('k1:material-one', 'k1')
    await putSecret('OLD_KEY', 'sk-old')
    setRing('k1:material-one,k2:material-two', 'k2')

    const res = await keys()
    expect(res.body.secrets.find((s) => s.name === 'OLD_KEY')).toEqual({
      name: 'OLD_KEY',
      keyId: 'k1',
      stale: true,
    })
    expect(res.body.stale).toBeGreaterThan(0)
  })

  it('is owner-only, and 404s a non-member', async () => {
    expect((await keys(memberToken)).status).toBe(403)
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: `out-${uuidv4()}@example.com`, password: 'password123', displayName: 'Out' })
    expect((await keys(outsider.body.token)).status).toBe(404)
  })
})

describe('rotating', () => {
  it('moves every secret to the active key and keeps the values readable', async () => {
    setRing('k1:material-one', 'k1')
    await putSecret('STRIPE_KEY', 'sk-live-abc')
    await putSecret('SLACK_URL', 'https://hooks.example.com/x')

    setRing('k1:material-one,k2:material-two', 'k2')
    const res = await rotate()

    expect(res.status).toBe(200)
    expect(res.body.activeKeyId).toBe('k2')
    expect(res.body.names).toEqual(expect.arrayContaining(['STRIPE_KEY', 'SLACK_URL']))
    expect(res.body.failed).toEqual([])
    // The credential survives the rotation unchanged, which is the only thing
    // that actually matters.
    expect(decryptSecret(storedValue('STRIPE_KEY'))).toBe('sk-live-abc')
    expect(keyIdOf(storedValue('STRIPE_KEY'))).toBe('k2')
  })

  it('never re-encrypts the value itself — only the wrapped data key moves', async () => {
    // The property the envelope exists for: the rotation holds a 32-byte data
    // key, never a credential.
    setRing('k1:material-one', 'k1')
    await putSecret('WRAPPED', 'sk-live-wrapped')
    const before = storedValue('WRAPPED')

    setRing('k1:material-one,k2:material-two', 'k2')
    await rotate()
    const after = storedValue('WRAPPED')

    expect(after.split(':').slice(3)).toEqual(before.split(':').slice(3))
    expect(after.split(':')[2]).not.toBe(before.split(':')[2])
  })

  it('is idempotent', async () => {
    setRing('k1:material-one,k2:material-two', 'k2')
    await putSecret('ALREADY', 'sk-live')
    const res = await rotate()
    expect(res.body.rotated).toBe(0)
    expect(res.body.unchanged).toBeGreaterThan(0)
  })

  it('does not touch updated_at, because the secret did not change', async () => {
    // Moving it would make the UI claim somebody rotated the credential when
    // nobody did.
    setRing('k1:material-one', 'k1')
    await putSecret('TIMESTAMPED', 'sk-live')
    const before = db
      .prepare('SELECT updated_at FROM workspace_secrets WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, 'TIMESTAMPED').updated_at

    setRing('k1:material-one,k2:material-two', 'k2')
    await rotate()

    const after = db
      .prepare('SELECT updated_at FROM workspace_secrets WHERE workspace_id = ? AND name = ?')
      .get(workspaceId, 'TIMESTAMPED').updated_at
    expect(after).toBe(before)
  })

  it('reports a secret whose key was retired without aborting the rest', async () => {
    setRing('gone:retired-material', 'gone')
    await putSecret('ORPHANED', 'sk-orphan')
    setRing('k9:brand-new', 'k9')
    await putSecret('FINE', 'sk-fine')

    const res = await rotate()
    expect(res.body.failed).toContainEqual(
      expect.objectContaining({ name: 'ORPHANED', error: expect.stringContaining('not in the current key ring') })
    )
    // …and the rest of the workspace is untouched rather than half-written.
    expect(decryptSecret(storedValue('FINE'))).toBe('sk-fine')
  })

  it('is owner-only', async () => {
    expect((await rotate(memberToken)).status).toBe(403)
  })

  it('records a re-key in the audit chain, with no value in it', async () => {
    setRing('k1:material-one', 'k1')
    await putSecret('AUDITED', 'sk-live-audited')
    setRing('k1:material-one,k2:material-two', 'k2')
    await rotate()

    const entry = db
      .prepare(
        "SELECT * FROM audit_log WHERE workspace_id = ? AND action = 'secret.rekeyed' ORDER BY seq DESC LIMIT 1"
      )
      .get(workspaceId)
    expect(entry).toBeTruthy()
    // An auditor asking "when did we last rotate the key, and who?" gets an
    // answer that cannot have been edited — and it holds no credential.
    expect(entry.metadata).toContain('k2')
    expect(entry.metadata).not.toContain('sk-live-audited')
  })
})

describe('a workflow run after rotation', () => {
  it('still resolves {{secrets.NAME}} to the original value', async () => {
    // The end-to-end claim: rotation is invisible to everything downstream.
    setRing('k1:material-one', 'k1')
    await putSecret('RUNTIME_KEY', 'sk-runtime-value')
    setRing('k1:material-one,k2:material-two', 'k2')
    await rotate()

    const { loadWorkspaceSecrets } = require('../services/executionEngine')
    expect(loadWorkspaceSecrets(workspaceId).RUNTIME_KEY).toBe('sk-runtime-value')
  })
})
