// Signed workflow artifacts, tested as an algorithm: what the signature covers,
// what it deliberately ignores, and the three ways verification can say no.
//
// The property that carries the design is that the signature is over the graph's
// **meaning** rather than its bytes. Half of this file is therefore about
// changes that must *not* break a signature — a node dragged, a config key
// reordered, a connection redrawn — because a signature that breaks for cosmetic
// reasons is one people learn to skip, and the other half is about the changes
// that must.

const crypto = require('crypto')
const signing = require('../services/artifactSigning')

const node = (id, type, config = {}, label = id, position = { x: 0, y: 0 }) => ({
  id,
  type,
  position,
  data: { label, config },
})

const DOC = {
  exportVersion: '1.0',
  name: 'Order sync',
  description: 'nightly',
  graph_data: {
    nodes: [
      node('hook', 'trigger-webhook'),
      node('charge', 'action-http', { url: 'https://api.acme.com/charge', method: 'POST' }, 'Charge'),
    ],
    edges: [{ id: 'e1', source: 'hook', target: 'charge', sourceHandle: null }],
  },
  guarantees: [{ kind: 'requires', node: 'charge', other: 'hook', note: 'reviewed by Ada' }],
  exportedAt: '2026-01-01T00:00:00.000Z',
}

const keys = signing.generateKeyPair()
const other = signing.generateKeyPair()

const sign = (doc, privateKey = keys.privateKey) => ({
  ...doc,
  signature: signing.signDocument(doc, privateKey),
})

const trusted = (pair = keys, extra = {}) => [
  { id: 'k1', name: 'release', publicKey: pair.publicKey, fingerprint: pair.fingerprint, ...extra },
]

describe('key material', () => {
  it('produces an Ed25519 pair with a readable fingerprint', () => {
    expect(keys.publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    expect(keys.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    expect(crypto.createPublicKey(keys.publicKey).asymmetricKeyType).toBe('ed25519')
    // Eight colon-grouped octets: short enough to read out, long enough not to
    // collide.
    expect(keys.fingerprint).toMatch(/^([0-9a-f]{8}:){7}[0-9a-f]{8}$/)
  })

  it('derives the same fingerprint from a public key alone', () => {
    expect(signing.fingerprint(keys.publicKey)).toBe(keys.fingerprint)
    expect(signing.fingerprint(other.publicKey)).not.toBe(keys.fingerprint)
  })
})

describe('what the signature covers', () => {
  it('verifies a document it signed', () => {
    expect(signing.verifyDocument(sign(DOC), trusted())).toEqual({
      status: 'trusted',
      key: { id: 'k1', name: 'release', fingerprint: keys.fingerprint },
    })
  })

  it('ignores everything that is not what the workflow means', () => {
    const signed = sign(DOC)
    const cosmetic = {
      ...signed,
      // A re-export stamps a new time and may reorder top-level keys.
      exportedAt: '2026-06-06T12:00:00.000Z',
      description: 'edited freely — prose is not a promise',
      graph_data: {
        nodes: [
          // Dragged across the canvas, and its config keys reordered.
          node('charge', 'action-http', { method: 'POST', url: 'https://api.acme.com/charge' }, 'Charge', { x: 900, y: 40 }),
          node('hook', 'trigger-webhook', {}, 'hook', { x: -20, y: 300 }),
        ],
        // The same connection, redrawn — React Flow mints a new edge id.
        edges: [{ id: 'e-redrawn', source: 'hook', target: 'charge', sourceHandle: null }],
      },
      guarantees: [{ kind: 'requires', node: 'charge', other: 'hook', note: 'note rewritten' }],
    }
    expect(signing.verifyDocument(cosmetic, trusted()).status).toBe('trusted')
  })

  it('breaks on every change that alters behaviour', () => {
    const signed = sign(DOC)
    const tamper = (mutate) => {
      const copy = JSON.parse(JSON.stringify(signed))
      mutate(copy)
      return signing.verifyDocument(copy, trusted()).status
    }

    // The URL money goes to.
    expect(tamper((d) => { d.graph_data.nodes[1].data.config.url = 'https://evil.example.net' })).toBe('invalid')
    // A node's type.
    expect(tamper((d) => { d.graph_data.nodes[1].type = 'action-email' })).toBe('invalid')
    // Its label, which is what a reviewer read.
    expect(tamper((d) => { d.graph_data.nodes[1].data.label = 'Refund' })).toBe('invalid')
    // A node added, and one removed.
    expect(tamper((d) => { d.graph_data.nodes.push(node('extra', 'action-http')) })).toBe('invalid')
    expect(tamper((d) => { d.graph_data.nodes.pop() })).toBe('invalid')
    // Rewiring, including only the handle — the difference between the approved
    // and the rejected branch.
    expect(tamper((d) => { d.graph_data.edges[0].target = 'extra' })).toBe('invalid')
    expect(tamper((d) => { d.graph_data.edges[0].sourceHandle = 'error' })).toBe('invalid')
    expect(tamper((d) => { d.graph_data.edges = [] })).toBe('invalid')
    // The workflow's name, which is what the import lands under.
    expect(tamper((d) => { d.name = 'Order sync (copy)' })).toBe('invalid')
    // And the assertions that were the reason it passed review.
    expect(tamper((d) => { d.guarantees = [] })).toBe('invalid')
    expect(tamper((d) => { d.guarantees[0].other = 'extra' })).toBe('invalid')
  })

  it('is stable across serialisation, so a digest can be compared by eye', () => {
    const round = JSON.parse(JSON.stringify(DOC))
    expect(signing.digestOf(round)).toBe(signing.digestOf(DOC))
    expect(signing.digestOf(DOC)).toMatch(/^[0-9a-f]{64}$/)
    // And it is a *different* digest for a different graph.
    const changed = JSON.parse(JSON.stringify(DOC))
    changed.graph_data.nodes[1].data.config.url = 'https://elsewhere.example.com'
    expect(signing.digestOf(changed)).not.toBe(signing.digestOf(DOC))
  })
})

describe('the three ways verification says no', () => {
  it('unsigned — no claim was made', () => {
    expect(signing.verifyDocument(DOC, trusted())).toEqual({ status: 'unsigned', key: null })
  })

  it('untrusted — a real signature by a key this workspace does not hold', () => {
    // What a rotated or revoked key looks like, and it is not tampering.
    expect(signing.verifyDocument(sign(DOC, other.privateKey), trusted()).status).toBe('untrusted')
    expect(signing.verifyDocument(sign(DOC), []).status).toBe('untrusted')
  })

  it('invalid — the payload does not match a signature by a key we do trust', () => {
    const signed = sign(DOC)
    signed.name = 'Something else'
    expect(signing.verifyDocument(signed, trusted()).status).toBe('invalid')
  })

  it('refuses a garbled signature instead of throwing', () => {
    for (const block of [
      { algorithm: 'ed25519', signature: 'not base64 !!!' },
      { algorithm: 'ed25519', signature: '' },
      { algorithm: 'rsa', signature: 'AAAA' },
      { algorithm: 'ed25519' },
      {},
    ]) {
      expect(() => signing.verifyDocument({ ...DOC, signature: block }, trusted())).not.toThrow()
      expect(signing.verifyDocument({ ...DOC, signature: block }, trusted()).status).not.toBe('trusted')
    }
    // A trust store holding nonsense is a failed verification, not a crash.
    expect(
      signing.verifyDocument(sign(DOC), [{ id: 'bad', name: 'bad', publicKey: 'not a key', fingerprint: 'x' }]).status
    ).toBe('untrusted')
  })

  it('finds the right key however many are trusted, and whatever the hint says', () => {
    const store = [
      { id: 'k0', name: 'old', publicKey: other.publicKey, fingerprint: other.fingerprint },
      ...trusted(),
    ]
    expect(signing.verifyDocument(sign(DOC), store).key.id).toBe('k1')

    // The fingerprint is a lookup hint, not a credential: lying about it cannot
    // make an untrusted signature verify, and cannot stop a trusted one.
    const lying = sign(DOC)
    lying.signature.keyFingerprint = other.fingerprint
    expect(signing.verifyDocument(lying, store).key.id).toBe('k1')

    const forged = sign(DOC, other.privateKey)
    forged.signature.keyFingerprint = keys.fingerprint
    expect(signing.verifyDocument(forged, trusted()).status).toBe('invalid')
  })
})
