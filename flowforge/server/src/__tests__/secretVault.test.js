process.env.JWT_SECRET = 'test-secret'
process.env.NODE_ENV = 'test'

const { encryptSecret, decryptSecret } = require('../services/secretVault')

describe('secret vault (AES-256-GCM)', () => {
  it('round-trips a value', () => {
    const stored = encryptSecret('sk-live-abc123')
    expect(decryptSecret(stored)).toBe('sk-live-abc123')
  })

  it('round-trips unicode and long values', () => {
    const long = 'x'.repeat(4096)
    expect(decryptSecret(encryptSecret(long))).toBe(long)
    expect(decryptSecret(encryptSecret('påsswörd-秘密'))).toBe('påsswörd-秘密')
  })

  it('never stores plaintext and uses a fresh IV per encryption', () => {
    const a = encryptSecret('same-value')
    const b = encryptSecret('same-value')
    expect(a).not.toContain('same-value')
    expect(a).not.toBe(b) // random IV → different ciphertext for equal plaintext
    expect(a.startsWith('v1:')).toBe(true)
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const stored = encryptSecret('integrity-matters')
    const parts = stored.split(':')
    const data = Buffer.from(parts[3], 'base64')
    data[0] ^= 0xff
    parts[3] = data.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow(/decryption failed/i)
  })

  it('rejects an unknown format', () => {
    expect(() => decryptSecret('not-a-secret')).toThrow(/unrecognized/i)
    expect(() => decryptSecret('v9:a:b:c')).toThrow(/unrecognized/i)
  })

  it('rejects non-string plaintext', () => {
    expect(() => encryptSecret(42)).toThrow(/string/)
  })
})
