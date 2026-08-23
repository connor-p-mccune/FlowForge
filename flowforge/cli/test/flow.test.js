// The `.flow` half of `flowforge export` / `flowforge import`.
//
// The CLI deliberately carries no copy of the grammar — the text goes over the
// wire and the server parses it — so what these pin is the wiring: which
// endpoint is hit, that the text reaches stdout unwrapped, and that a syntax
// error keeps the line number the parser found.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { startStub, makeCtx } = require('./helpers')
const exportWorkflow = require('../src/commands/export')
const importWorkflow = require('../src/commands/import')
const diff = require('../src/commands/diff')
const lint = require('../src/commands/lint')
const merge = require('../src/commands/merge')
const preview = require('../src/commands/preview')

const FLOW = `workflow "Order pipeline"
  description: "Handles orders"

node charge: action-http @ 480,160
  label: "Charge card"
  method: "POST"

node hook: trigger-webhook @ 100,200
  label: "Order webhook"

hook -> charge
`

const JSON_DOC = {
  exportVersion: '1.0',
  name: 'Order pipeline',
  graph_data: { nodes: [{ id: 'n1', type: 'output-log' }], edges: [] },
}

// Write a file into a temp dir and hand back its path.
function tempFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-dsl-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents)
  return file
}

test('export --flow asks for the text form and prints it unwrapped', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/export?format=flow')
    // Served as a raw body, which is what the server does — a JSON-encoded
    // string would be a different thing to test against.
    return { text: FLOW }
  })
  const ctx = makeCtx(stub.api)
  const code = await exportWorkflow({ positionals: ['wf-1'], flags: { flow: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /workflow "Order pipeline"/)
  assert.match(ctx.output(), /hook -> charge/)
  assert.ok(!/exportVersion/.test(ctx.output()))
})

test('export without --flow still prints the JSON document', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/export')
    return { json: JSON_DOC }
  })
  const ctx = makeCtx(stub.api)
  await exportWorkflow({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.match(ctx.output(), /"exportVersion": "1.0"/)
})

test('import sends a .flow file as text rather than parsing it here', async () => {
  const file = tempFile('sync.flow', FLOW)
  const stub = await startStub(() => ({
    json: { workflow: { id: 'wf-9', name: 'Order pipeline' } },
  }))
  const ctx = makeCtx(stub.api)
  const code = await importWorkflow({ positionals: ['ws-1', file], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.deepEqual(stub.requests[0].body, { flow: FLOW })
  assert.match(ctx.output(), /Imported .*Order pipeline.* as a draft/)
})

test('import recognises a .flow file by its contents too', async () => {
  // A file named anything at all still imports if it is obviously one form.
  const file = tempFile('definition.txt', FLOW)
  const stub = await startStub(() => ({ json: { workflow: { id: 'wf-9', name: 'X' } } }))
  const ctx = makeCtx(stub.api)
  await importWorkflow({ positionals: ['ws-1', file], flags: {} }, ctx)
  await stub.close()
  assert.ok('flow' in stub.requests[0].body)
})

test('import still sends a JSON export as a document', async () => {
  const file = tempFile('sync.json', JSON.stringify(JSON_DOC))
  const stub = await startStub(() => ({ json: { workflow: { id: 'wf-9', name: 'Order pipeline' } } }))
  const ctx = makeCtx(stub.api)
  await importWorkflow({ positionals: ['ws-1', file], flags: {} }, ctx)
  await stub.close()

  assert.equal(stub.requests[0].body.name, 'Order pipeline')
  assert.ok(!('flow' in stub.requests[0].body))
})

test('import keeps the line number a syntax error came back with', async () => {
  const file = tempFile('broken.flow', 'workflow "W"\nnode n: action-http\n  method: POST\n')
  const stub = await startStub(() => ({
    status: 400,
    json: { error: 'Line 3: Value must be JSON — strings need quotes ("POST", not POST)', line: 3 },
  }))
  const ctx = makeCtx(stub.api)
  const code = await importWorkflow({ positionals: ['ws-1', file], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Line 3/)
  assert.match(ctx.output(), /strings need quotes/)
})

test('import warns that --name does nothing for a .flow file', async () => {
  // The name is a line in the file; editing it there is the diff a reviewer
  // wants, rather than a flag nothing records.
  const file = tempFile('sync.flow', FLOW)
  const stub = await startStub(() => ({ json: { workflow: { id: 'wf-9', name: 'Order pipeline' } } }))
  const ctx = makeCtx(stub.api)
  await importWorkflow({ positionals: ['ws-1', file], flags: { name: 'Renamed' } }, ctx)
  await stub.close()

  assert.match(ctx.output(), /--name is ignored for a \.flow file/)
  assert.deepEqual(stub.requests[0].body, { flow: FLOW })
})

test('import reports a missing file rather than throwing', async () => {
  const ctx = makeCtx(null)
  const code = await importWorkflow({ positionals: ['ws-1', 'nope.flow'], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Could not read/)
})

// The format is only useful if every tool that reads a definition reads it. A
// `.flow` file that could be imported but not diffed, linted, merged or
// previewed would be a format nobody could adopt.

async function sendsFlow(command, positionals, response) {
  const stub = await startStub(() => ({ json: response }))
  const ctx = makeCtx(stub.api)
  await command({ positionals, flags: {} }, ctx)
  await stub.close()
  return stub.requests[0].body
}

test('diff sends a .flow file as text', async () => {
  const file = tempFile('sync.flow', FLOW)
  const body = await sendsFlow(diff, ['wf-1', file], { identical: true })
  assert.deepEqual(body, { flow: FLOW })
})

test('lint sends a .flow file as text', async () => {
  const file = tempFile('sync.flow', FLOW)
  const body = await sendsFlow(lint, ['wf-1', file], {
    issues: [], summary: { errors: 0, warnings: 0 },
  })
  assert.deepEqual(body, { flow: FLOW })
})

test('merge sends a .flow file as text, keeping its own flags', async () => {
  const file = tempFile('sync.flow', FLOW)
  const body = await sendsFlow(merge, ['wf-1', file], {
    conflicts: [], applied: false, base: { version: 3 }, changes: {},
  })
  assert.equal(body.flow, FLOW)
  assert.equal(body.strategy, 'manual')
  assert.equal(body.apply, false)
})

test('preview sends a .flow file as text', async () => {
  const file = tempFile('sync.flow', FLOW)
  const body = await sendsFlow(preview, ['wf-1', file], {
    replayed: 0, differing: 0, differences: [], skipped: [],
  })
  assert.deepEqual(body, { flow: FLOW })
})

test('each of them still sends a JSON export as a graph', async () => {
  const file = tempFile('sync.json', JSON.stringify(JSON_DOC))
  const body = await sendsFlow(diff, ['wf-1', file], { identical: true })
  assert.ok(!('flow' in body))
  assert.deepEqual(body.graph_data, JSON_DOC.graph_data)
})
