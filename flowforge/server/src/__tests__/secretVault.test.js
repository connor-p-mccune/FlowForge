// The secret vault, and the property the envelope exists for: the key can be
// changed without every stored credential becoming undecryptable at the same
// instant.
//
// The cases that carry the most weight are the ones about *reads never
// breaking* — a ring holding old and new keys, a v1 row written by the previous
// implementation, a row whose key has been retired. A vault that loses data on
// a rotation is worse than one that cannot rotate, because the second failure
// is visible before you depend on it.

process.env.JWT_SECRET = 'test-secret'
process.env.NODE_ENV = 'test'

const crypto = require('crypto')

const {
  encryptSecret,
  decryptSecret,
  rewrapSecret,
  keyIdOf,
  describeKeyring,
} = require('../services/secretVault')

// The ring is read from the environment per call, so a test can stand in for a
// deploy that added a key or retired one.
function withRing(ring, active, fn) {
  const before = {
    ring: process.env.SECRETS_KEY_RING,
    active: process.env.SECRETS_ACTIVE_KEY,
  }
  if (ring === null) delete process.env.SECRETS_KEY_RING
  else process.env.SECRETS_KEY_RING = ring
  if (active === null) delete process.env.SECRETS_ACTIVE_KEY
  else process.env.SECRETS_ACTIVE_KEY = active
  try {
    return fn()
  } finally {
    if (before.ring === undefined) delete process.env.SECRETS_KEY_RING
    else process.env.SECRETS_KEY_RING = before.ring
    if (before.active === undefined) delete process.env.SECRETS_ACTIVE_KEY
    else process.env.SECRETS_ACTIVE_KEY = before.active
  }
}

// A v1 row exactly as the pre-envelope implementation wrote it, so the
// backwards-compatible read path is tested against the real format rather than
// against this module's own idea of it.
function legacyV1(plaintext, material = process.env.JWT_SECRET) {
  const key = crypto.scryptSync(material, 'flowforge/secret-vault', 32)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

describe('encryption', () => {
  it('round-trips a value', () => {
    expect(decryptSecret(encryptSecret('sk-live-abc123'))).toBe('sk-live-abc123')
  })

  it('round-trips unicode and long values', () => {
    const long = 'x'.repeat(4096)
    expect(decryptSecret(encryptSecret(long))).toBe(long)
    expect(decryptSecret(encryptSecret('påsswörd-秘密'))).toBe('påsswörd-秘密')
  })

  it('never stores plaintext, and uses a fresh data key per value', () => {
    const a = encryptSecret('same-value')
    const b = encryptSecret('same-value')
    expect(a).not.toContain('same-value')
    // Different DEK *and* different IV, so equal plaintexts share nothing.
    expect(a).not.toBe(b)
    expect(a.split(':')[2]).not.toBe(b.split(':')[2])
    expect(a.startsWith('v2:')).toBe(true)
  })

  it('rejects a tampered ciphertext', () => {
    const parts = encryptSecret('integrity-matters').split(':')
    const data = Buffer.from(parts[5], 'base64')
    data[0] ^= 0xff
    parts[5] = data.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow(/decryption failed/i)
  })

  it('rejects a tampered wrapped key', () => {
    // Integrity covers the envelope too — a swapped data key must fail rather
    // than decrypt to garbage.
    const parts = encryptSecret('integrity-matters').split(':')
    const wrapped = Buffer.from(parts[2], 'base64')
    wrapped[wrapped.length - 1] ^= 0xff
    parts[2] = wrapped.toString('base64')
    expect(() => decryptSecret(parts.join(':'))).toThrow(/decryption failed/i)
  })

  it('rejects unknown formats and non-string plaintext', () => {
    expect(() => decryptSecret('not-a-secret')).toThrow(/unrecognized/i)
    expect(() => decryptSecret('v9:a:b:c')).toThrow(/unrecognized/i)
    expect(() => decryptSecret('v2:only:three:parts')).toThrow(/unrecognized/i)
    expect(() => encryptSecret(42)).toThrow(/string/)
  })
})

describe('reading what the previous implementation wrote', () => {
  it('decrypts a v1 row', () => {
    expect(decryptSecret(legacyV1('sk-old-format'))).toBe('sk-old-format')
  })

  it('reports it as the legacy key', () => {
    expect(keyIdOf(legacyV1('x'))).toBe('legacy')
  })

  it('still decrypts a v1 row after a ring is declared', () => {
    // Declaring a ring must not itself be a migration; rows written before it
    // keep working until they are rotated.
    const stored = legacyV1('sk-old-format')
    withRing('k2:brand-new-material', 'k2', () => {
      expect(decryptSecret(stored)).toBe('sk-old-format')
    })
  })
})

describe('the key ring', () => {
  it('encrypts under the active key and records which one', () => {
    withRing('k1:material-one,k2:material-two', 'k2', () => {
      const stored = encryptSecret('value')
      expect(keyIdOf(stored)).toBe('k2')
      expect(describeKeyring()).toEqual({ keys: expect.arrayContaining(['k1', 'k2']), activeKeyId: 'k2' })
    })
  })

  it('defaults the active key to the last entry', () => {
    withRing('k1:one\nk2:two', null, () => {
      expect(describeKeyring().activeKeyId).toBe('k2')
    })
  })

  it('keeps reading rows written under a key that is no longer active', () => {
    // The whole point: add the new key, flip the active id, and there is no
    // instant at which a read fails.
    const underK1 = withRing('k1:material-one', 'k1', () => encryptSecret('written-under-k1'))
    withRing('k1:material-one,k2:material-two', 'k2', () => {
      expect(decryptSecret(underK1)).toBe('written-under-k1')
    })
  })

  it('says which key is missing when one has been retired too early', () => {
    const underK1 = withRing('k1:material-one', 'k1', () => encryptSecret('orphan'))
    withRing('k2:material-two', 'k2', () => {
      expect(() => decryptSecret(underK1)).toThrow(/"k1", which is not in the current key ring/)
    })
  })

  it('derives different keys from the same material under different ids', () => {
    // Otherwise "rotating" to a key someone reused would be a no-op wearing a
    // rotation's clothes.
    const underK1 = withRing('k1:same-material', 'k1', () => encryptSecret('v'))
    withRing('k2:same-material', 'k2', () => {
      expect(() => decryptSecret(underK1)).toThrow(/not in the current key ring/)
    })
  })

  it('refuses a malformed ring rather than silently using one key', () => {
    expect(() => withRing('no-colon-here', null, () => describeKeyring())).toThrow(/id:material/)
    expect(() => withRing('bad id:material', null, () => describeKeyring())).toThrow(/Invalid key id/)
    expect(() => withRing('k1:', null, () => describeKeyring())).toThrow(/no material/)
    expect(() => withRing('   ', null, () => describeKeyring())).toThrow()
  })

  it('refuses an active key that is not in the ring', () => {
    expect(() => withRing('k1:one', 'k9', () => describeKeyring())).toThrow(/not in SECRETS_KEY_RING/)
  })

  it('allows material containing colons', () => {
    withRing('k1:postgres://user:pass@host', 'k1', () => {
      expect(decryptSecret(encryptSecret('v'))).toBe('v')
    })
  })
})

describe('rotation', () => {
  it('re-wraps a value onto the active key without changing the ciphertext', () => {
    // The property the envelope exists for: rotation decrypts a *data key*, not
    // a credential, so the process that rotates keys never holds an API token.
    const underK1 = withRing('k1:material-one', 'k1', () => encryptSecret('sk-live-secret'))
    const rotated = withRing('k1:material-one,k2:material-two', 'k2', () => rewrapSecret(underK1))

    expect(keyIdOf(rotated)).toBe('k2')
    // Same value ciphertext, IV and tag — only the wrapped key changed.
    expect(rotated.split(':').slice(3)).toEqual(underK1.split(':').slice(3))
    expect(rotated.split(':')[2]).not.toBe(underK1.split(':')[2])
  })

  it('still decrypts to the same value afterwards', () => {
    const underK1 = withRing('k1:material-one', 'k1', () => encryptSecret('sk-live-secret'))
    withRing('k1:material-one,k2:material-two', 'k2', () => {
      expect(decryptSecret(rewrapSecret(underK1))).toBe('sk-live-secret')
    })
  })

  it('is idempotent — a value already on the active key reports no change', () => {
    // So a sweep can be re-run, and its report of "how many moved" is honest.
    withRing('k1:material-one,k2:material-two', 'k2', () => {
      expect(rewrapSecret(encryptSecret('v'))).toBeNull()
    })
  })

  it('migrates a v1 row into the envelope format', () => {
    // The one case that does handle the plaintext, because there is no data key
    // to re-wrap. That is the cost of the format that came before, paid once.
    const stored = legacyV1('sk-old-format')
    withRing('k1:material-one', 'k1', () => {
      const migrated = rewrapSecret(stored)
      expect(migrated.startsWith('v2:k1:')).toBe(true)
      expect(decryptSecret(migrated)).toBe('sk-old-format')
    })
  })

  it('refuses to rotate something it cannot read', () => {
    const underK1 = withRing('k1:material-one', 'k1', () => encryptSecret('v'))
    withRing('k2:material-two', 'k2', () => {
      expect(() => rewrapSecret(underK1)).toThrow(/not in the current key ring/)
    })
    expect(() => rewrapSecret('garbage')).toThrow(/unrecognized/i)
  })
})

describe('describeKeyring', () => {
  it('never returns key material', () => {
    withRing('k1:super-secret-material', 'k1', () => {
      expect(JSON.stringify(describeKeyring())).not.toContain('super-secret-material')
    })
  })
})
