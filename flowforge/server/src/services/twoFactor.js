// Two-factor authentication (TOTP) helpers.
//
// Keeps the speakeasy / qrcode / bcrypt mechanics out of routes/auth.js so the
// route handlers read as plain orchestration. A user's TOTP secret is a base32
// string stored on the users row; backup codes are one-time recovery codes,
// bcrypt-hashed and stored as a JSON array of { hash, used } so a consumed code
// can never be replayed.

const crypto = require('crypto')
const bcrypt = require('bcrypt')
const speakeasy = require('speakeasy')
const QRCode = require('qrcode')

const ISSUER = process.env.TOTP_ISSUER || 'FlowForge'
const BACKUP_CODE_COUNT = 8
const BACKUP_CODE_LENGTH = 10
// Uppercase letters + digits. Generated codes are uppercase, and verification
// upper-cases user input, so the codes are effectively case-insensitive to type.
const BACKUP_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const BCRYPT_ROUNDS = 10
// Allow ±1 time step (±30s) so a code entered near a step boundary still verifies.
const VERIFY_WINDOW = 1

// Generate a fresh TOTP secret plus the otpauth:// URI an authenticator app scans.
function generateSecret(email) {
  const secret = speakeasy.generateSecret({ length: 20 })
  const otpauthUrl = speakeasy.otpauthURL({
    secret: secret.base32,
    encoding: 'base32',
    label: `${ISSUER}:${email}`,
    issuer: ISSUER,
  })
  return { secret: secret.base32, otpauthUrl }
}

// Render an otpauth URI to a base64 PNG data URL for the setup QR code.
function toQRCode(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl)
}

// Verify a 6-digit TOTP code against a base32 secret.
function verifyToken(secret, token) {
  if (!secret || !token) return false
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: String(token).replace(/\s/g, ''),
    window: VERIFY_WINDOW,
  })
}

// Securely pick one random backup code (rejection sampling avoids modulo bias).
function randomBackupCode() {
  const limit = 256 - (256 % BACKUP_CODE_CHARS.length)
  let out = ''
  while (out.length < BACKUP_CODE_LENGTH) {
    const byte = crypto.randomBytes(1)[0]
    if (byte >= limit) continue
    out += BACKUP_CODE_CHARS[byte % BACKUP_CODE_CHARS.length]
  }
  return out
}

function generateBackupCodes() {
  return Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode)
}

// bcrypt-hash a list of plaintext codes into the { hash, used } shape we persist.
async function hashBackupCodes(codes) {
  const hashed = []
  for (const code of codes) {
    hashed.push({ hash: await bcrypt.hash(code, BCRYPT_ROUNDS), used: false })
  }
  return hashed
}

function normalizeBackupCode(code) {
  return String(code).replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

// Find the index of an unused backup code matching `code`, or -1 if none match.
// The caller marks the returned index used and persists, so a code is single-use.
async function findUnusedBackupCode(stored, code) {
  const normalized = normalizeBackupCode(code)
  if (!normalized) return -1
  for (let i = 0; i < stored.length; i++) {
    if (stored[i].used) continue
    if (await bcrypt.compare(normalized, stored[i].hash)) return i
  }
  return -1
}

// A 6-digit numeric string is treated as a TOTP code; anything else as a backup code.
function looksLikeTotp(code) {
  return /^\d{6}$/.test(String(code).replace(/\s/g, ''))
}

module.exports = {
  generateSecret,
  toQRCode,
  verifyToken,
  generateBackupCodes,
  hashBackupCodes,
  findUnusedBackupCode,
  looksLikeTotp,
  BACKUP_CODE_COUNT,
}
