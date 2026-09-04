// flowforge impact — what does this change *mean*?
//
// The exit code splits along the line the report is built on. A finding some
// other gate already refuses fails the build on its own, because a pipeline
// running this and not those should still stop. Everything else is legal,
// deployable, and the reason this command exists — and `--strict` is how a
// pipeline says it wants to stop for those too.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { startStub, makeCtx } = require('./helpers')
const impact = require('../src/commands/impact')

const finding = (over = {}) => ({
  code: 'ungated-effect',
  severity: 100,
  blocking: false,
  summary: 'Charge card now runs on every run',
  detail: 'It was gated before this change; nothing in the graph gates it now.',
  nodeId: 'c',
  subject: 'wf1:c',
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workflowId: 'wf1',
  name: 'Orders',
  findings: [finding()],
  resolved: [],
  nodes: { added: [], removed: [] },
  summary: { introduced: 1, resolved: 0, blocking: 0, review: 1, verdict: 'review', ...over.summary },
  ...over,
})

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-impact-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents)
  return file
}

const EXPORT = JSON.stringify({ graph_data: { nodes: [], edges: [] } })

async function run(payload, { flags = {}, file = tmpFile('wf.json', EXPORT) } = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await impact({ positionals: ['wf-1', file], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('reports what a one-line edit does, with the detail under it', async () => {
  const { out } = await run(report())
  assert.match(out, /What this change does to Orders/)
  assert.match(out, /Charge card now runs on every run/)
  assert.match(out, /nothing in the graph gates it now/)
})

test('exits 0 on a legal change, because nothing refuses it', async () => {
  // The whole point of the tier: it is deployable, and somebody should read it.
  const { code, out } = await run(report())
  assert.equal(code, 0)
  assert.match(out, /1 finding\(s\) are legal and deployable/)
})

test('--strict stops for those too', async () => {
  assert.equal((await run(report(), { flags: { strict: true } })).code, 1)
})

test('exits non-zero without --strict when another gate would refuse it', async () => {
  // A pipeline running this and not `verify` should still stop.
  const blocked = report({
    findings: [finding({ code: 'guarantee-broken', blocking: true, summary: 'A declared guarantee no longer holds' })],
    summary: { introduced: 1, resolved: 0, blocking: 1, review: 0, verdict: 'blocked' },
  })
  const { code, out } = await run(blocked)
  assert.equal(code, 1)
  assert.match(out, /would be refused at deploy anyway/)
})

test('says plainly when a change alters nothing anybody was relying on', async () => {
  const clear = report({
    findings: [],
    summary: { introduced: 0, resolved: 0, blocking: 0, review: 0, verdict: 'clear' },
  })
  const { code, out } = await run(clear)
  assert.equal(code, 0)
  assert.match(out, /Nothing this change does alters what the workflow guarantees/)
})

test('reports what the change fixed as well as what it broke', async () => {
  // A reviewer told only about the bad half cannot tell a refactor from a
  // regression.
  const fixed = report({
    findings: [],
    resolved: [{ code: 'effect-gated', summary: 'Charge card is now gated', subject: 'wf1:c' }],
    summary: { introduced: 0, resolved: 1, blocking: 0, review: 0, verdict: 'clear' },
  })
  const { code, out } = await run(fixed)
  assert.equal(code, 0)
  assert.match(out, /What it fixes/)
  assert.match(out, /Charge card is now gated/)
})

test('warns that a resolved/introduced pair may be one node redrawn', async () => {
  const swapped = report({ nodes: { added: ['new'], removed: ['old'] } })
  const { out } = await run(swapped)
  assert.match(out, /1 node\(s\) added and 1 removed/)
  assert.match(out, /may be one node redrawn/)
})

test('stays quiet about node churn when only one side changed', async () => {
  const { out } = await run(report({ nodes: { added: ['new'], removed: [] } }))
  assert.ok(!out.includes('may be one node redrawn'), out)
})

test('sends a .flow file as text for the server to parse', async () => {
  // The CLI carries no copy of the grammar, so a syntax error comes back
  // carrying the line the parser found.
  const file = tmpFile('wf.flow', 'workflow "Orders"\n  webhook t "Start"\n')
  const { requests } = await run(report(), { file })
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/impact')
  assert.equal(typeof requests[0].body.flow, 'string')
  assert.equal(requests[0].body.graph_data, undefined)
})

test('sends a JSON export as graph_data', async () => {
  const { requests } = await run(report())
  assert.deepEqual(requests[0].body, { graph_data: { nodes: [], edges: [] } })
})

test('refuses a JSON file that is not a workflow export', async () => {
  const file = tmpFile('nope.json', JSON.stringify({ hello: 'world' }))
  const { code, out } = await run(report(), { file })
  assert.equal(code, 1)
  assert.match(out, /not a workflow export/)
})

test('reports an unreadable file rather than throwing', async () => {
  const { code, out } = await run(report(), { file: path.join(os.tmpdir(), 'ff-missing.json') })
  assert.equal(code, 1)
  assert.match(out, /Could not read/)
})

test('handles a workflow with nothing to compare against', async () => {
  const { code, out } = await run({ available: false, reason: 'empty' })
  assert.equal(code, 0)
  assert.match(out, /nothing to compare/)
})

test('without both arguments prints usage and fails', async () => {
  const ctx = makeCtx(null)
  assert.equal(await impact({ positionals: ['wf-1'], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge impact/)
})
