// Which runs are about which person.
//
// A data subject request — *"show me everything you hold about me"*, *"delete
// everything you hold about me"* — is unanswerable without a way to find the
// runs that concern one person. FlowForge records executions, not customers,
// and nothing in a run says whose it is.
//
// A workflow declares it: `workflows.subject_path` names the field of the
// trigger payload that identifies the data subject (`customer.email`,
// `user.id`). At run start the engine resolves that path and stores a
// **pseudonymous** identifier on the execution row, so the runs about one
// person can be found by index rather than by scanning every payload.
//
// ---
//
// **Why the identifier is pseudonymous, and why that is not theatre.**
//
// The obvious index is the email itself, and it is wrong for a reason that
// shows up the moment you try to *honour* the request rather than just service
// it: after erasure you must keep proof that the erasure happened — who asked,
// when, what scope — and a row keyed on `alice@example.com` means the one
// artefact you are contractually obliged to retain is a copy of the identifier
// you were asked to delete.
//
// So the key is `HMAC-SHA256(pepper, workspace || identifier)`. Two properties
// follow:
//
//   * The database alone does not contain the identifier. A dump, a backup, a
//     read-replica: none of them names anybody.
//   * An operator holding the identifier can still *derive* the key and find
//     the runs, which is exactly the operation a subject request needs.
//
// It is a keyed hash rather than a plain one because a plain hash of an email
// is a dictionary attack, not a pseudonym: the space of email addresses is
// small enough to enumerate. The pepper is what makes the mapping
// non-reversible without it.
//
// **The limit, stated rather than glossed.** A pseudonymous identifier is
// still personal data under GDPR — it is linkable to a person by anyone
// holding the pepper, which is the whole point of it being usable. What it
// buys is that the linkage requires a secret the database does not contain,
// which is the same bargain [the secret vault](./secretVault.js) makes and the
// same one it is honest about.

const crypto = require('crypto')

// Scoped per workspace so the same person in two workspaces has two
// identifiers. A shared one would let a workspace confirm that an address it
// holds also appears in somebody else's — which is a cross-tenant leak
// dressed as an optimisation.
function pepper() {
  const material =
    process.env.SUBJECT_PEPPER || process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!material) throw new Error('SUBJECT_PEPPER (or JWT_SECRET) must be set')
  // Derived rather than used raw, so a shared JWT secret is never the HMAC key
  // itself and rotating one does not silently mean the other.
  return crypto.createHash('sha256').update(`flowforge:subject:${material}`).digest()
}

// Case and whitespace are presentation, not identity: `Alice@Example.com ` and
// `alice@example.com` are the same person, and a request that missed the runs
// recorded under the other spelling would be a request nobody could rely on.
function normalise(identifier) {
  return String(identifier ?? '').trim().toLowerCase()
}

// The pseudonymous key for one identifier in one workspace, or null when there
// is nothing to key on. 32 hex characters — 128 bits, far past any collision
// concern at any workspace size, and short enough to read in a certificate.
function subjectIdFor(workspaceId, identifier) {
  const value = normalise(identifier)
  if (!value || !workspaceId) return null
  return crypto
    .createHmac('sha256', pepper())
    .update(`${workspaceId}\n${value}`)
    .digest('hex')
    .slice(0, 32)
}

// Read `customer.email` out of a trigger payload.
//
// Deliberately does not walk arrays or coerce objects: an identifier is a
// scalar, and a path that lands on a list has not identified one person. A
// number is accepted (`user.id` is a legitimate subject key) and stringified.
function valueAtPath(payload, path) {
  if (!path) return null
  let current = payload
  for (const segment of String(path).split('.')) {
    if (current == null || typeof current !== 'object' || Array.isArray(current)) return null
    current = current[segment]
  }
  if (current == null) return null
  if (typeof current === 'string' || typeof current === 'number') return String(current)
  return null
}

// The subject id for a run, or null when the workflow declares no subject path,
// the payload does not carry it, or the value is not a scalar.
//
// Null is a normal answer and never an error: most workflows are not about a
// person, and a run whose payload happens to be missing the field is not a
// failure to record — it is a run with no data subject, which is a different
// and correct thing.
function subjectOf(workspaceId, subjectPath, triggerPayload) {
  if (!subjectPath) return null
  const value = valueAtPath(triggerPayload, subjectPath)
  if (!value) return null
  return subjectIdFor(workspaceId, value)
}

module.exports = { subjectIdFor, subjectOf, valueAtPath, normalise }
