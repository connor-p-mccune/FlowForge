// flowforge preview — the promotion gate that is about behaviour rather than
// form.
//
// The exit code is the design decision worth pinning. Behaviour changing is the
// *expected* outcome of a deploy, so a difference reports and passes; `--strict`
// is what turns it into a build failure, and it exists for the promotion that
// claims to be inert — a refactor, a rename, a config-only edit. A replay that
// errored always fails, because there the preview could not answer at all.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { startStub, makeCtx } = require('./helpers')
const preview = require('../src/commands/preview')

const DOC = {
  name: 'Order sync',
  graph_data: {
    nodes: [{ id: 'hook', type: 'trigger-webhook', data: {} }],
    edges: [],
  },
}

const CHANGED = {
  workflowId: 'wf-1',
  ok: false,
  analysed: true,
  truncated: false,
  runs: 20,
  identical: 19,
  changed: [
    {
      executionId: 'exec-1',
      at: '2026-01-12T09:00:00.000Z',
      before: { status: 'completed', path: ['hook', 'big', 'vip'] },
      after: { status: 'failed', path: ['hook', 'big', 'normal'] },
      difference: {
        identical: false,
        statusChanged: true,
        started: ['normal'],
        stopped: ['vip'],
        routed: [{ nodeId: 'big', before: true, after: false }],
      },
    },
  ],
  summary: {
    changed: 1,
    statusChanges: 1,
    routingChanges: 1,
    nodesStarted: ['normal'],
    nodesStopped: ['vip'],
    errors: 0,
  },
}

const IDENTICAL = {
  ...CHANGED,
  ok: true,
  identical: 20,
  changed: [],
  summary: { changed: 0, statusChanges: 0, routingChanges: 0, nodesStarted: [], nodesStopped: [], errors: 0 },
}

function writeDoc(doc = DOC) {
  const file = path.join(os.tmpdir(), `ff-preview-${Date.now()}-${Math.random()}.json`)
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}

async function run(payload, flags = {}, doc = DOC) {
  const file = writeDoc(doc)
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await preview({ positionals: ['wf-1', file], flags }, ctx)
  await stub.close()
  fs.unlinkSync(file)
  return { code, out: ctx.output(), requests: stub.requests }
}

test('usage without both arguments', async () => {
  const ctx = makeCtx(null)
  assert.equal(await preview({ positionals: ['wf-1'], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge preview/)
})

test('a missing or malformed file fails cleanly', async () => {
  const ctx = makeCtx(null)
  assert.equal(await preview({ positionals: ['wf-1', '/nope/none.json'], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Could not read/)

  const bad = writeDoc({ nope: true })
  const ctx2 = makeCtx(null)
  assert.equal(await preview({ positionals: ['wf-1', bad], flags: {} }, ctx2), 1)
  assert.match(ctx2.output(), /does not look like an exported workflow/)
  fs.unlinkSync(bad)
})

test('sends the document’s graph and reports each differing run', async () => {
  const { code, out, requests } = await run(CHANGED)
  assert.equal(code, 0) // reporting, not failing — that is what --strict is for
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/preview')
  assert.deepEqual(requests[0].body.graph_data.nodes, DOC.graph_data.nodes)
  assert.match(out, /1 of 20 replayed runs would behave differently/)
  assert.match(out, /status completed → failed/)
  assert.match(out, /big routes true → false/)
  assert.match(out, /now runs: normal/)
  assert.match(out, /no longer runs: vip/)
  assert.match(out, /Pass --strict/)
})

test('--strict fails the build on any behaviour change', async () => {
  assert.equal((await run(CHANGED, { strict: true })).code, 1)
  assert.equal((await run(IDENTICAL, { strict: true })).code, 0)
})

test('an inert promotion says so', async () => {
  const { code, out } = await run(IDENTICAL)
  assert.equal(code, 0)
  assert.match(out, /All 20 replayed runs behave identically/)
})

test('a replay that errored always fails, strict or not', async () => {
  const errored = {
    ...CHANGED,
    changed: [{ executionId: 'exec-1', at: 'x', error: 'boom', difference: null }],
    summary: { ...CHANGED.summary, errors: 1 },
  }
  assert.equal((await run(errored)).code, 1)
})

test('a workflow with no history is reported, not failed', async () => {
  const { code, out } = await run({ analysed: false, reason: 'no-runs', runs: 0, changed: [] })
  assert.equal(code, 0)
  assert.match(out, /No run history to replay/)
})

test('an unfinished preview says so rather than reading as clean', async () => {
  const { out } = await run({ ...IDENTICAL, truncated: true })
  assert.match(out, /ran out of time/)
})

test('--runs is passed through and --json keeps the exit code', async () => {
  const { requests } = await run(CHANGED, { runs: '5' })
  assert.equal(requests[0].body.runs, 5)

  const { code, out } = await run(CHANGED, { json: true, strict: true })
  assert.equal(code, 1)
  assert.equal(JSON.parse(out).workflowId, 'wf-1')
})
