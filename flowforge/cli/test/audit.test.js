const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const audit = require('../src/commands/audit')

const OK_VERIFY = {
  ok: true,
  entries: 2,
  head: 'f'.repeat(64),
  brokenAt: null,
  verifiedAt: '2026-08-05T12:00:00Z',
}

const BROKEN_VERIFY = {
  ok: false,
  entries: 9,
  head: null,
  brokenAt: {
    seq: 4,
    id: 'e4',
    reason: 'hash-mismatch',
    detail: 'this entry’s contents no longer match its recorded hash',
  },
  verifiedAt: '2026-08-05T12:00:00Z',
}

const ENTRIES = [
  {
    id: 'e2',
    seq: 2,
    action: 'member.role_changed',
    actor: 'Ada',
    targetName: 'Grace',
    metadata: { from: 'member', to: 'owner' },
    createdAt: '2026-08-05T14:32:07Z',
  },
  {
    id: 'e1',
    seq: 1,
    action: 'secret.created',
    actor: 'Ada',
    targetName: 'STRIPE_KEY',
    metadata: null,
    createdAt: '2026-08-05T14:30:00Z',
  },
]

function stubFor({ verify = OK_VERIFY, entries = ENTRIES } = {}) {
  return startStub((method, url) => {
    if (url.includes('/audit/verify')) return { json: verify }
    if (url.includes('/audit')) return { json: { entries, hasMore: false } }
    return { status: 404, json: { error: 'Not found' } }
  })
}

test('audit verifies the chain and lists entries newest-first', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  const code = await audit({ positionals: ['ws-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Chain verified/)
  assert.match(ctx.output(), /2 entries, unbroken/)
  // The head is printed so an operator can record it externally without a
  // second call — that anchor is what would catch a wholesale rewrite.
  assert.match(ctx.output(), new RegExp('f'.repeat(64)))
  assert.match(ctx.output(), /Grace: member → owner/)
  assert.match(ctx.output(), /created secret STRIPE_KEY/)
})

test('audit exits non-zero when the chain is broken', async () => {
  // The whole reason the command exists in this shape: a cron line that pages
  // someone when the log stops being trustworthy.
  const stub = await stubFor({ verify: BROKEN_VERIFY })
  const ctx = makeCtx(stub.api)
  const code = await audit({ positionals: ['ws-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Chain verification FAILED/)
  assert.match(ctx.output(), /Entry #4/)
  assert.match(ctx.output(), /hash-mismatch/)
})

test('audit --verify checks only, skipping the listing request', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  const code = await audit({ positionals: ['ws-1'], flags: { verify: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.length, 1)
  assert.match(stub.requests[0].path, /\/audit\/verify$/)
})

test('audit passes --limit and --action through to the API', async () => {
  const stub = await stubFor()
  const ctx = makeCtx(stub.api)
  await audit({ positionals: ['ws-1'], flags: { limit: 10, action: 'secret.*' } }, ctx)
  await stub.close()

  const listing = stub.requests.find((r) => !r.path.includes('/verify'))
  assert.match(listing.path, /limit=10/)
  assert.match(listing.path, /action=secret/)
})

test('audit reports an empty log without claiming a problem', async () => {
  const stub = await stubFor({ verify: { ...OK_VERIFY, entries: 0 }, entries: [] })
  const ctx = makeCtx(stub.api)
  const code = await audit({ positionals: ['ws-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /No audit entries yet/)
})

test('audit without a workspace id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await audit({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge audit/)
})
