// HMAC signing for the public webhook trigger (SECURITY.md T3). A webhook
// created with signing enabled stores a per-webhook secret; every delivery to
// it must then carry
//
//   X-FlowForge-Timestamp: <unix seconds>
//   X-FlowForge-Signature: v1=<hex>
//
// where the signature is HMAC-SHA256(secret, `${timestamp}.${rawBody}`) over
// the exact raw request bytes. The timestamp is part of the signed payload and
// is checked against a tolerance window, so a captured request can't be
// replayed later. Comparison is constant-time. The unguessable webhook key
// stays as the first factor; the signature is the second.

const crypto = require('crypto')

const DEFAULT_TOLERANCE_SECONDS = 300 // 5 minutes of clock skew / transit delay
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/

function generateSigningSecret() {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`
}

// The hex HMAC for a delivery. `timestamp` is signed exactly as transmitted
// (string), avoiding any canonicalization mismatch between signer and verifier.
function computeSignature(secret, timestamp, rawBody) {
  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(`${timestamp}.`)
  hmac.update(rawBody == null ? Buffer.alloc(0) : rawBody)
  return hmac.digest('hex')
}

// Verify a delivery. Returns { ok: true } or { ok: false, error } with a
// message safe to echo to the caller (never the expected signature).
function verifyWebhookSignature({
  secret,
  timestampHeader,
  signatureHeader,
  rawBody,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowMs = Date.now,
}) {
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, error: 'Missing X-FlowForge-Timestamp / X-FlowForge-Signature headers' }
  }
  const timestamp = Number(timestampHeader)
  if (!Number.isFinite(timestamp)) {
    return { ok: false, error: 'Invalid signature timestamp' }
  }
  if (Math.abs(nowMs() / 1000 - timestamp) > toleranceSeconds) {
    return { ok: false, error: 'Signature timestamp outside tolerance' }
  }
  const match = SIGNATURE_PATTERN.exec(String(signatureHeader).trim())
  if (!match) {
    return { ok: false, error: 'Malformed signature header (expected v1=<hex sha256>)' }
  }
  const expected = Buffer.from(computeSignature(secret, timestampHeader, rawBody), 'hex')
  const provided = Buffer.from(match[1], 'hex')
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { ok: false, error: 'Invalid signature' }
  }
  return { ok: true }
}

module.exports = {
  generateSigningSecret,
  computeSignature,
  verifyWebhookSignature,
  DEFAULT_TOLERANCE_SECONDS,
}
