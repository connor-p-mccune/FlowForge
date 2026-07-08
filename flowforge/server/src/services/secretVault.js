// Secret vault: authenticated encryption for workspace secrets at rest.
//
// Values are encrypted with AES-256-GCM before they touch the database, so a
// leaked SQLite file (or backup) exposes no credentials. GCM gives integrity as
// well as confidentiality — a tampered row fails decryption instead of quietly
// returning garbage.
//
// The 256-bit key is derived with scrypt from SECRETS_ENCRYPTION_KEY, falling
// back to JWT_SECRET so a fresh install works with the two variables the app
// already requires. The salt is a fixed app-specific string: scrypt here is a
// KDF for one server-held key material, not a password database, so a static
// salt only needs to domain-separate this key from any other use of the same
// material.
//
// Stored format (one TEXT column):  v1:<iv b64>:<authTag b64>:<ciphertext b64>
// The version prefix leaves room to rotate algorithms/keys without a rewrite of
// every row on day one.

const crypto = require('crypto')

const VERSION = 'v1'
const IV_BYTES = 12 // 96-bit IV, the GCM-recommended size

let cachedKey = null
let cachedMaterial = null

function getKey() {
  const material = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!material) {
    throw new Error('Secret vault needs SECRETS_ENCRYPTION_KEY or JWT_SECRET to be set')
  }
  // Re-derive only when the material changes (tests swap env vars; production
  // derives once per process).
  if (cachedKey && cachedMaterial === material) return cachedKey
  cachedKey = crypto.scryptSync(material, 'flowforge/secret-vault', 32)
  cachedMaterial = material
  return cachedKey
}

function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('Secret value must be a string')
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

function decryptSecret(stored) {
  const parts = String(stored).split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognized secret format')
  }
  const [, ivB64, tagB64, dataB64] = parts
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  // GCM throws on a bad tag — wrap it in a stable message so callers never leak
  // crypto internals to API responses.
  try {
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Secret decryption failed (wrong key or corrupted value)')
  }
}

module.exports = { encryptSecret, decryptSecret }
