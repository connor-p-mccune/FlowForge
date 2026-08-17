// keygen / sign, and the contract that matters most here: **the CLI's
// canonicalisation and the server's are the same function.**
//
// They are two implementations on purpose — the CLI has no dependencies and must
// work standing alone, so reaching into the server's source would make `npm link`
// depend on a repository layout. That is the same trade node-cron and
// `cronExpression.js` make for schedules, and it carries the same obligation:
// tests that pin the two together, because a divergence would not fail loudly.
// It would produce a signature that verifies nowhere, discovered by whoever is
// mid-promotion at 2am.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { makeCtx } = require('./helpers')
const cli = require('../src/signing')
const keygen = require('../src/commands/keygen')
const sign = require('../src/commands/sign')

// The server's implementation. Required from the test rather than from the
// runtime, so the CLI package stays self-contained while the contract is still
// checked. artifactSigning.js depends on `crypto` alone, so this pulls in no
// database and no server.
const server = require('../../server/src/services/artifactSigning')

const tmp = (name) => path.join(os.tmpdir(), `ff-sign-${process.pid}-${Date.now()}-${name}`)

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
  guarantees: [{ kind: 'requires', node: 'charge', other: 'hook', note: 'reviewed' }],
  exportedAt: '2026-01-01T00:00:00.000Z',
}

// A spread of shapes, including the empty and the odd, so the contract is
// checked over more than one happy document.
const DOCUMENTS = [
  DOC,
  { name: '', graph_data: { nodes: [], edges: [] } },
  { name: 'no guarantees', graph_data: { nodes: [node('a', 'output-log')], edges: [] } },
  {
    name: 'unicode ✓ and "quotes"',
    graph_data: {
      nodes: [node('n', 'transform', { template: '{"a":1}', nested: { deep: [1, 'two', null] } })],
      edges: [{ id: 'x', source: 'n', target: 'n', sourceHandle: 'error' }],
    },
    guarantees: [{ kind: 'ensures', node: 'n', other: 'n' }],
  },
]

test('the two canonicalisations are one function', () => {
  for (const doc of DOCUMENTS) {
    assert.equal(cli.canonicalPayload(doc), server.canonicalPayload(doc))
    assert.equal(cli.digestOf(doc), server.digestOf(doc))
  }
})

test('a signature made by the CLI verifies on the server', () => {
  const pair = cli.generateKeyPair()
  for (const doc of DOCUMENTS) {
    const signed = { ...doc, signature: cli.signDocument(doc, pair.privateKey) }
    const verdict = server.verifyDocument(signed, [
      { id: 'k', name: 'release', publicKey: pair.publicKey, fingerprint: pair.fingerprint },
    ])
    assert.equal(verdict.status, 'trusted')
  }
})

test('a signature made by the server verifies in the CLI', () => {
  const pair = server.generateKeyPair()
  const signed = { ...DOC, signature: server.signDocument(DOC, pair.privateKey) }
  assert.equal(cli.verifyDocument(signed, pair.publicKey), true)
})

test('both agree on the fingerprint of a key', () => {
  const pair = cli.generateKeyPair()
  assert.equal(cli.fingerprint(pair.publicKey), server.fingerprint(pair.publicKey))
  assert.equal(pair.fingerprint, server.fingerprint(pair.publicKey))
})

test('keygen writes both halves and refuses to overwrite either', async () => {
  const prefix = tmp('kg')
  const ctx = makeCtx(null)
  assert.equal(await keygen({ positionals: [], flags: { out: prefix } }, ctx), 0)
  assert.match(ctx.output(), /Key pair generated/)
  assert.ok(fs.existsSync(`${prefix}.key`))
  assert.ok(fs.existsSync(`${prefix}.pub`))
  assert.match(fs.readFileSync(`${prefix}.key`, 'utf8'), /BEGIN PRIVATE KEY/)

  // Silently replacing a signing key is how a release stops verifying with no
  // commit behind it.
  const again = makeCtx(null)
  assert.equal(await keygen({ positionals: [], flags: { out: prefix } }, again), 1)
  assert.match(again.output(), /refusing to overwrite/)

  fs.unlinkSync(`${prefix}.key`)
  fs.unlinkSync(`${prefix}.pub`)
})

async function withSigningFixture(run) {
  const prefix = tmp('fixture')
  const pair = cli.generateKeyPair()
  fs.writeFileSync(`${prefix}.key`, pair.privateKey)
  fs.writeFileSync(`${prefix}.pub`, pair.publicKey)
  const docPath = `${prefix}.json`
  fs.writeFileSync(docPath, JSON.stringify(DOC))
  try {
    await run({ prefix, docPath, pair })
  } finally {
    for (const f of [`${prefix}.key`, `${prefix}.pub`, docPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  }
}

test('sign attaches a signature in place and prints the digest', async () => {
  await withSigningFixture(async ({ prefix, docPath, pair }) => {
    const ctx = makeCtx(null)
    assert.equal(await sign({ positionals: [docPath], flags: { key: `${prefix}.key` } }, ctx), 0)
    assert.match(ctx.output(), /Signed/)
    assert.match(ctx.output(), new RegExp(cli.digestOf(DOC)))
    assert.match(ctx.output(), new RegExp(pair.fingerprint))

    const written = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    assert.equal(written.signature.algorithm, 'ed25519')
    assert.equal(cli.verifyDocument(written, pair.publicKey), true)
  })
})

test('--check verifies a file with no server, token, or trust in the pipeline', async () => {
  await withSigningFixture(async ({ prefix, docPath, pair }) => {
    await sign({ positionals: [docPath], flags: { key: `${prefix}.key` } }, makeCtx(null))

    const ok = makeCtx(null)
    assert.equal(await sign({ positionals: [docPath], flags: { check: `${prefix}.pub` } }, ok), 0)
    assert.match(ok.output(), /verifies against/)

    // Tampering after signing fails, and says which of the two problems it is.
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    doc.graph_data.nodes[1].data.config.url = 'https://evil.example.net'
    fs.writeFileSync(docPath, JSON.stringify(doc))
    const bad = makeCtx(null)
    assert.equal(await sign({ positionals: [docPath], flags: { check: `${prefix}.pub` } }, bad), 1)
    assert.match(bad.output(), /does not verify/)
    assert.match(bad.output(), /modified/)

    // A signature by a different key reads as a different problem.
    const other = cli.generateKeyPair()
    const otherPub = `${prefix}.other.pub`
    fs.writeFileSync(otherPub, other.publicKey)
    const foreign = makeCtx(null)
    assert.equal(await sign({ positionals: [docPath], flags: { check: otherPub } }, foreign), 1)
    assert.match(foreign.output(), new RegExp(`claims to be signed by ${pair.fingerprint}`))
    fs.unlinkSync(otherPub)
  })
})

test('re-signing replaces the block rather than signing over it', async () => {
  await withSigningFixture(async ({ prefix, docPath, pair }) => {
    await sign({ positionals: [docPath], flags: { key: `${prefix}.key` } }, makeCtx(null))
    const first = JSON.parse(fs.readFileSync(docPath, 'utf8')).signature
    await sign({ positionals: [docPath], flags: { key: `${prefix}.key` } }, makeCtx(null))
    const second = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    // Ed25519 is deterministic, so the same payload and key give the same
    // signature — which is the evidence the second signing covered the payload
    // and not the first signature.
    assert.equal(second.signature.signature, first.signature)
    assert.equal(cli.verifyDocument(second, pair.publicKey), true)
  })
})

test('--out writes elsewhere and leaves the original alone', async () => {
  await withSigningFixture(async ({ prefix, docPath, pair }) => {
    const out = `${prefix}.signed.json`
    assert.equal(
      await sign({ positionals: [docPath], flags: { key: `${prefix}.key`, out } }, makeCtx(null)),
      0
    )
    assert.equal(JSON.parse(fs.readFileSync(docPath, 'utf8')).signature, undefined)
    assert.equal(cli.verifyDocument(JSON.parse(fs.readFileSync(out, 'utf8')), pair.publicKey), true)
    fs.unlinkSync(out)
  })
})

test('sign fails cleanly on bad input', async () => {
  const usage = makeCtx(null)
  assert.equal(await sign({ positionals: [], flags: {} }, usage), 1)
  assert.match(usage.output(), /Usage: flowforge sign/)

  const missing = makeCtx(null)
  assert.equal(await sign({ positionals: ['/nope/none.json'], flags: { key: 'x' } }, missing), 1)
  assert.match(missing.output(), /Could not read/)

  const notAnExport = tmp('bad.json')
  fs.writeFileSync(notAnExport, JSON.stringify({ hello: true }))
  const shaped = makeCtx(null)
  assert.equal(await sign({ positionals: [notAnExport], flags: { key: 'x' } }, shaped), 1)
  assert.match(shaped.output(), /does not look like an exported workflow/)

  const noKey = makeCtx(null)
  const doc = tmp('ok.json')
  fs.writeFileSync(doc, JSON.stringify(DOC))
  assert.equal(await sign({ positionals: [doc], flags: {} }, noKey), 1)
  assert.match(noKey.output(), /--key/)

  const badKey = makeCtx(null)
  const keyFile = tmp('bad.key')
  fs.writeFileSync(keyFile, 'not a key')
  assert.equal(await sign({ positionals: [doc], flags: { key: keyFile } }, badKey), 1)
  assert.match(badKey.output(), /Could not sign/)

  const unsigned = makeCtx(null)
  const pub = tmp('some.pub')
  fs.writeFileSync(pub, cli.generateKeyPair().publicKey)
  assert.equal(await sign({ positionals: [doc], flags: { check: pub } }, unsigned), 1)
  assert.match(unsigned.output(), /carries no signature/)

  for (const f of [notAnExport, doc, keyFile, pub]) fs.unlinkSync(f)
})
