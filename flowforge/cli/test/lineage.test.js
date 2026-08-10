// flowforge lineage — the map, the per-node trace, and the CI gate.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const lineage = require('../src/commands/lineage')

const MAP = {
  workflowId: 'wf-1',
  ok: true,
  nodes: [
    {
      nodeId: 'hook',
      label: 'Order webhook',
      nodeType: 'trigger-webhook',
      origins: [{ kind: 'webhook', trust: 'untrusted', label: 'the webhook payload' }],
      reads: [],
      readBy: ['charge'],
      secrets: [],
      variables: [],
    },
    {
      nodeId: 'charge',
      label: 'Charge card',
      nodeType: 'action-http',
      origins: [{ kind: 'response', trust: 'external', label: 'an HTTP response' }],
      reads: [{ nodeId: 'hook', reference: 'hook.url', where: 'url' }],
      readBy: [],
      secrets: ['STRIPE_KEY'],
      variables: ['BASE_URL'],
    },
  ],
  sinks: [
    {
      nodeId: 'charge',
      label: 'Charge card',
      key: 'url',
      kind: 'http-url',
      sensitivity: 'high',
      what: 'the address this request is sent to',
      via: ['hook.url'],
      origins: ['webhook'],
    },
  ],
  secretReach: { STRIPE_KEY: [{ nodeId: 'charge', label: 'Charge card', where: 'headers' }] },
  findings: [
    {
      severity: 'warning',
      code: 'tainted-sink',
      message: 'Charge card: the address this request is sent to is built from the webhook payload',
      nodeId: 'charge',
    },
  ],
}

const NODE_TRACE = {
  workflowId: 'wf-1',
  ok: true,
  provenance: {
    nodeId: 'charge',
    label: 'Charge card',
    origins: [{ kind: 'webhook', trust: 'untrusted', label: 'the webhook payload', detail: 'written by whoever holds the trigger URL' }],
    outputOrigins: [{ kind: 'response', trust: 'external', label: 'an HTTP response' }],
    secrets: [{ kind: 'secret', name: 'STRIPE_KEY', where: 'headers' }],
    variables: [],
    chain: [
      { from: 'hook', fromLabel: 'Order webhook', to: 'charge', toLabel: 'Charge card', path: 'url', where: 'url', reference: 'hook.url' },
    ],
  },
  impact: {
    nodeId: 'charge',
    label: 'Charge card',
    affected: [
      { nodeId: 'mail', label: 'Receipt', nodeType: 'action-email', distance: 1, references: [{ reference: 'charge.body.id', where: 'body' }] },
    ],
    sinks: [
      { nodeId: 'charge', label: 'Charge card', sensitivity: 'high', what: 'the address this request is sent to' },
    ],
  },
}

test('prints the dataflow map, the sinks, and the secret reach', async () => {
  const stub = await startStub(() => ({ json: MAP }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].path, '/api/v1/workflows/wf-1/lineage')
  const out = ctx.output()
  assert.match(out, /the webhook payload/)
  assert.match(out, /the address this request is sent to/)
  assert.match(out, /STRIPE_KEY/)
  assert.match(out, /tainted|built from the webhook payload/)
})

test('--strict turns a finding into a non-zero exit, plain mode does not', async () => {
  const strictStub = await startStub(() => ({ json: MAP }))
  const strictCtx = makeCtx(strictStub.api)
  const strict = await lineage({ positionals: ['wf-1'], flags: { strict: true } }, strictCtx)
  await strictStub.close()
  assert.equal(strict, 1)

  const lenientStub = await startStub(() => ({ json: MAP }))
  const lenientCtx = makeCtx(lenientStub.api)
  const lenient = await lineage({ positionals: ['wf-1'], flags: {} }, lenientCtx)
  await lenientStub.close()
  assert.equal(lenient, 0)
})

test('a clean graph says so', async () => {
  const stub = await startStub(() => ({ json: { ...MAP, findings: [], sinks: [], secretReach: {} } }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: ['wf-1'], flags: { strict: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /No dataflow findings/)
})

test('--node asks the server for one node and prints both directions', async () => {
  const stub = await startStub(() => ({ json: NODE_TRACE }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: ['wf-1'], flags: { node: 'charge' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].path, '/api/v1/workflows/wf-1/lineage?node=charge')
  const out = ctx.output()
  assert.match(out, /what feeds it/)
  assert.match(out, /what breaks if it changes/)
  assert.match(out, /Order webhook/)
  assert.match(out, /Receipt/)
  // The input/output origin split is printed when they differ — confusing the
  // two is how a taint finding gets misread.
  assert.match(out, /its own output is an HTTP response/)
  assert.match(out, /high-sensitivity sink/)
})

test('--json prints the raw report for a script', async () => {
  const stub = await startStub(() => ({ json: MAP }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: ['wf-1'], flags: { json: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(JSON.parse(ctx.output()).workflowId, 'wf-1')
})

test('a cyclic graph reports that rather than printing nothing', async () => {
  const stub = await startStub(() => ({ json: { workflowId: 'wf-1', ok: false, reason: 'cycle' } }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /cycle/)
})

test('lineage without a workflow id prints usage and fails', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await lineage({ positionals: [], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge lineage/)
})
