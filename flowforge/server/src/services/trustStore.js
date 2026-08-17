// The workspace trust store — which signing keys this workspace will accept a
// workflow definition from.
//
// `artifactSigning.js` is the pure half: it canonicalises a document, signs it,
// and verifies a signature against key material handed to it. This is the half
// that knows where the keys live, who may change that list, and what happens to
// an import whose signature does not check out.
//
// Three decisions shape it, and each mirrors a control that already exists here.
//
// **Owner-managed, like secrets and status-page tokens.** A trust store any
// member could append to is not a trust store — it is a formality. The same
// argument [policies](./policyEngine.js) make about a control anybody can switch
// off.
//
// **Revoked, never deleted.** A revoked key keeps its row with `revoked_at` set,
// exactly as [API tokens](../routes/tokens.js) do, because the question an
// incident review asks is *what did this key sign while it was trusted* — and a
// deleted row answers it with silence.
//
// **A bad signature is refused whether or not signatures are required.** The
// enforcement flag decides what an *unsigned* document means, which is a policy
// question a workspace answers for itself. It does not decide what a *broken*
// signature means: that is evidence of tampering, and there is no configuration
// under which the right response is to shrug and import it. Conflating the two
// is the mistake that makes signing decorative.

const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const db = require('../config/database')
const { fingerprint, verifyDocument, digestOf } = require('./artifactSigning')

// Present a stored row in the API's shape. The public key is included — it is
// public, and a reviewer checking that the key in the workspace is the key in
// their password manager needs to see it.
const present = (row) => ({
  id: row.id,
  name: row.name,
  publicKey: row.public_key,
  fingerprint: row.fingerprint,
  addedBy: row.added_by_name || null,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
  active: !row.revoked_at,
})

function listKeys(workspaceId, { includeRevoked = true } = {}) {
  const rows = db
    .prepare(
      `SELECT k.*, u.display_name AS added_by_name
         FROM workspace_signing_keys k
         LEFT JOIN users u ON u.id = k.added_by
        WHERE k.workspace_id = ?
          ${includeRevoked ? '' : 'AND k.revoked_at IS NULL'}
        ORDER BY k.created_at DESC`
    )
    .all(workspaceId)
  return rows.map(present)
}

// The keys a verification may match against: active ones only. Revocation has
// to take effect immediately — a key revoked because it leaked must stop being
// accepted on the next import, not on the next deploy.
function trustedKeys(workspaceId) {
  return listKeys(workspaceId, { includeRevoked: false }).map((k) => ({
    id: k.id,
    name: k.name,
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
  }))
}

// Add a key, or an { error } describing why not.
//
// The key is parsed before it is stored, so a paste-o is a 400 rather than a
// key that silently never matches anything — the same reasoning behind
// type-checking a policy rule when it is saved instead of when it first fails
// to fire.
function addKey(workspaceId, userId, { name, publicKey }) {
  const label = typeof name === 'string' ? name.trim() : ''
  if (!label) return { error: 'A key name is required' }
  if (label.length > 100) return { error: 'Key name is too long (max 100 chars)' }
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    return { error: 'publicKey is required (PEM, SPKI)' }
  }

  let parsed
  try {
    parsed = crypto.createPublicKey(publicKey)
  } catch {
    return { error: 'publicKey is not a valid PEM public key' }
  }
  if (parsed.asymmetricKeyType !== 'ed25519') {
    return { error: `Only ed25519 keys are accepted (got ${parsed.asymmetricKeyType})` }
  }

  // Normalise to PEM/SPKI on the way in, so two spellings of one key cannot
  // both be trusted under different fingerprints.
  const pem = parsed.export({ type: 'spki', format: 'pem' }).toString()
  const print = fingerprint(pem)

  const existing = db
    .prepare('SELECT * FROM workspace_signing_keys WHERE workspace_id = ? AND fingerprint = ?')
    .get(workspaceId, print)
  if (existing && !existing.revoked_at) {
    return { error: `That key is already trusted (${print})` }
  }
  if (existing) {
    // Re-trusting a key that was revoked. Clearing the revocation rather than
    // inserting a second row keeps one history per key — "revoked on Tuesday,
    // trusted again on Friday" is the story, and two rows would tell it twice.
    db.prepare(
      'UPDATE workspace_signing_keys SET name = ?, revoked_at = NULL, added_by = ?, created_at = ? WHERE id = ?'
    ).run(label, userId, new Date().toISOString(), existing.id)
    return { key: listKeys(workspaceId).find((k) => k.id === existing.id), reinstated: true }
  }

  const id = uuidv4()
  db.prepare(
    `INSERT INTO workspace_signing_keys (id, workspace_id, name, public_key, fingerprint, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, workspaceId, label, pem, print, userId, new Date().toISOString())
  return { key: listKeys(workspaceId).find((k) => k.id === id), reinstated: false }
}

// Revoke a key. Idempotent: revoking an already-revoked key is a no-op that
// reports the row, because a retried request should not be an error.
function revokeKey(workspaceId, keyId) {
  const row = db
    .prepare('SELECT * FROM workspace_signing_keys WHERE id = ? AND workspace_id = ?')
    .get(keyId, workspaceId)
  if (!row) return { notFound: true }
  if (!row.revoked_at) {
    db.prepare('UPDATE workspace_signing_keys SET revoked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), keyId)
  }
  return { key: listKeys(workspaceId).find((k) => k.id === keyId) }
}

// Does this workspace insist on a trusted signature before an import?
function requiresSignature(workspace) {
  return Boolean(workspace?.require_signed_imports)
}

// The admission decision for one import.
//
// Returns the verification verdict, the digest of what was actually presented
// (so a caller can record or display it), and whether the import may proceed.
//
// The `allowed` rule is the whole point:
//
//   trusted     always allowed
//   unsigned    allowed unless the workspace requires signatures
//   untrusted   refused — a signature by a key nobody here vouches for is not
//               weaker evidence than no signature, it is a *claim* that failed
//   invalid     refused, always — the payload does not match a signature made
//               by a key we do trust, which is tampering
function verifyImport(workspace, document) {
  const verdict = verifyDocument(document, trustedKeys(workspace.id))
  const required = requiresSignature(workspace)
  const allowed =
    verdict.status === 'trusted' || (verdict.status === 'unsigned' && !required)
  return {
    ...verdict,
    required,
    allowed,
    digest: digestOf(document),
    reason: allowed ? null : refusal(verdict.status),
  }
}

function refusal(status) {
  switch (status) {
    case 'unsigned':
      return 'This workspace requires imports to be signed by a trusted key'
    case 'untrusted':
      return 'The document is signed by a key this workspace does not trust'
    default:
      return 'The signature does not match the document — it was modified after signing'
  }
}

module.exports = {
  present,
  listKeys,
  trustedKeys,
  addKey,
  revokeKey,
  requiresSignature,
  verifyImport,
}
