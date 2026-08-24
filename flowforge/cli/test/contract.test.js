// flowforge contract — whose workflows does this change break?
//
// The exit code carries the product, and it distinguishes two things a lesser
// check would conflate: a contract that *narrowed* (worth knowing) and a caller
// that *broke* (worth stopping a deployment for). A pipeline that failed on the
// first would be failing on changes nobody is affected by, which is how a check
// earns its way out of a pipeline.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { startStub, makeCtx } = require('./helpers')
const contract = require('../src/commands/contract')

const REPORT = {
  available: true,
  workflowId: 'wf-1',
  name: 'Fulfilment',
  before: { describe: '{ orderId: string, total: number }', fields: ['orderId', 'total'] },
  after: { describe: '{ total: number }', fields: ['total'] },
  change: {
    removed: [{ path: 'orderId', was: 'string' }],
    widened: [],
    weakened: [],
    added: [],
    verdict: 'breaking',
  },
  callers: [
    {
      workflowId: 'wf-2',
      name: 'Orders',
      status: 'deployed',
      breaks: [
        {
          nodeId: 'call',
          label: 'Fulfil order',
          reference: 'call.orderId',
          path: 'orderId',
          missing: 'orderId',
          reason: 'removed',
          suggestion: null,
        },
      ],
    },
  ],
  summary: { verdict: 'breaking', callers: 1, broken: 1, references: 1 },
}

const CLEAN = {
  ...REPORT,
  after: REPORT.before,
  change: { removed: [], widened: [], weakened: [], added: [], verdict: 'compatible' },
  callers: [{ workflowId: 'wf-2', name: 'Orders', status: 'deployed', breaks: [] }],
  summary: { verdict: 'compatible', callers: 1, broken: 0, references: 0 },
}

function withFile(contents, name = 'candidate.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-contract-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents)
  return file
}

async function run(payload, { positionals = ['wf-1'], flags = {} } = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await contract({ positionals, flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

const GRAPH = JSON.stringify({ graph_data: { nodes: [], edges: [] } })

test('reads the current promise and who depends on it', async () => {
  const { code, out } = await run(CLEAN)
  assert.equal(code, 0)
  assert.match(out, /Contract for Fulfilment/)
  assert.match(out, /returns \{ orderId: string, total: number \}/)
  assert.match(out, /1 caller, every reference still resolves/)
})

test('with no file it asks the read endpoint, not the candidate one', async () => {
  const { requests } = await run(CLEAN)
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/contract')
})

test('names the caller, the node and the reference that stops resolving', async () => {
  const file = withFile(GRAPH)
  const { code, out } = await run(REPORT, { positionals: ['wf-1', file] })
  assert.equal(code, 1)
  assert.match(out, /1 reference\(s\) would stop resolving/)
  assert.match(out, /Orders/)
  assert.match(out, /call\.orderId.* in Fulfil order/)
  assert.match(out, /no "orderId"/)
})

test('suggests the field somebody probably meant', async () => {
  const file = withFile(GRAPH)
  const renamed = {
    ...REPORT,
    callers: [
      {
        ...REPORT.callers[0],
        breaks: [{ ...REPORT.callers[0].breaks[0], suggestion: 'order_id' }],
      },
    ],
  }
  const { out } = await run(renamed, { positionals: ['wf-1', file] })
  assert.match(out, /did you mean "order_id"/)
})

test('shows the shape change as changelog lines', async () => {
  const file = withFile(GRAPH)
  const mixed = {
    ...REPORT,
    change: {
      removed: [{ path: 'orderId', was: 'string' }],
      widened: [{ path: 'total', was: 'number', now: 'number | string' }],
      weakened: [{ path: 'carrier' }],
      added: [{ path: 'trackingId', now: 'string' }],
      verdict: 'breaking',
    },
  }
  const { out } = await run(mixed, { positionals: ['wf-1', file] })
  assert.match(out, /− orderId \(was string\)/)
  assert.match(out, /~ total number → number \| string/)
  assert.match(out, /\? carrier is no longer always present/)
  assert.match(out, /\+ trackingId \(string\)/)
})

test('passes a narrowed contract nobody relies on', async () => {
  // The distinction the exit code exists for. The field went, so the shape
  // change is breaking — and no caller referenced it, so nothing is broken.
  const file = withFile(GRAPH)
  const harmless = {
    ...REPORT,
    callers: [{ workflowId: 'wf-2', name: 'Orders', status: 'deployed', breaks: [] }],
    summary: { verdict: 'breaking', callers: 1, broken: 0, references: 0 },
  }
  const { code, out } = await run(harmless, { positionals: ['wf-1', file] })
  assert.equal(code, 0)
  assert.match(out, /every reference still resolves/)
  assert.match(out, /contract is breaking/)
})

test('--strict fails on the shape change even with nobody broken', async () => {
  const file = withFile(GRAPH)
  const harmless = {
    ...REPORT,
    callers: [{ workflowId: 'wf-2', name: 'Orders', status: 'deployed', breaks: [] }],
    summary: { verdict: 'breaking', callers: 1, broken: 0, references: 0 },
  }
  const { code, out } = await run(harmless, { positionals: ['wf-1', file], flags: { strict: true } })
  assert.equal(code, 1)
  assert.match(out, /--strict treats the contract itself as the artefact/)
})

test('--strict still passes a compatible change', async () => {
  const file = withFile(GRAPH)
  const { code } = await run(CLEAN, { positionals: ['wf-1', file], flags: { strict: true } })
  assert.equal(code, 0)
})

test('says so when nothing calls this workflow', async () => {
  const alone = { ...CLEAN, callers: [], summary: { verdict: 'compatible', callers: 0, broken: 0, references: 0 } }
  const { code, out } = await run(alone)
  assert.equal(code, 0)
  assert.match(out, /Nothing in this workspace calls this workflow/)
})

test('counts the callers a change left alone', async () => {
  const file = withFile(GRAPH)
  const mixed = {
    ...REPORT,
    callers: [
      ...REPORT.callers,
      { workflowId: 'wf-3', name: 'Reports', status: 'deployed', breaks: [] },
    ],
    summary: { verdict: 'breaking', callers: 2, broken: 1, references: 1 },
  }
  const { out } = await run(mixed, { positionals: ['wf-1', file] })
  assert.match(out, /1 other caller\(s\) unaffected/)
})

test('sends a .flow file as text for the server to parse', async () => {
  const file = withFile('workflow "Fulfilment"\n', 'candidate.flow')
  const { requests } = await run(CLEAN, { positionals: ['wf-1', file] })
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].body.flow, 'workflow "Fulfilment"\n')
  assert.equal(requests[0].body.graph_data, undefined)
})

test('accepts a bare graph as well as a full export', async () => {
  const file = withFile(JSON.stringify({ nodes: [], edges: [] }))
  const { requests } = await run(CLEAN, { positionals: ['wf-1', file] })
  assert.deepEqual(requests[0].body.graph_data, { nodes: [], edges: [] })
})

test('reports an unreadable file rather than a stack trace', async () => {
  const ctx = makeCtx(null)
  const code = await contract({ positionals: ['wf-1', '/nope/missing.json'], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Could not read/)
})

test('reports a workflow whose stored graph will not parse', async () => {
  const { code, out } = await run({ available: false, reason: 'unreadable' })
  assert.equal(code, 1)
  assert.match(out, /could not be read/)
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await contract({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge contract/)
})
