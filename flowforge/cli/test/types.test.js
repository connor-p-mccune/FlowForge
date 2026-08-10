const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const types = require('../src/commands/types')

const REPORT = {
  workflowId: 'wf-1',
  order: ['t1', 'h1'],
  nodes: {
    t1: {
      input: { described: 'object' },
      output: { described: '{ triggered: boolean, … }', fields: [] },
    },
    h1: {
      input: { described: '{ triggered: boolean, … }' },
      output: {
        described: '{ status: number, body: any }',
        fields: [
          { path: 'status', type: 'number', optional: false },
          { path: 'body', type: 'any', optional: false },
          { path: 'wouldHaveSent', type: 'object', optional: true },
        ],
      },
    },
  },
  diagnostics: [],
}

const stubWith = (report) => startStub((method, url) => {
  assert.equal(method, 'GET')
  assert.equal(url, '/api/v1/workflows/wf-1/types')
  return { json: report }
})

test('types lists every node with the shape it produces', async () => {
  const stub = await stubWith(REPORT)
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /h1\s+\{ status: number, body: any \}/)
  assert.match(ctx.output(), /No type problems/)
})

test('--node prints the paste-ready reference for each field', async () => {
  const stub = await stubWith(REPORT)
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: { node: 'h1' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /\{\{h1\.status\}\} number/)
  assert.match(ctx.output(), /\{\{h1\.wouldHaveSent\}\} object \(optional\)/)
})

test('--node on a name the workflow does not have fails cleanly', async () => {
  const stub = await stubWith(REPORT)
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: { node: 'nope' } }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /No node "nope"/)
})

test('a type error fails the command, so it can gate CI on its own', async () => {
  const stub = await stubWith({
    ...REPORT,
    diagnostics: [
      { severity: 'error', code: 'unknown-field', message: 'o1: {{h1.bdy}} has no "bdy"', nodeId: 'o1' },
      { severity: 'warning', code: 'type-error', message: 'c1: always false', nodeId: 'c1' },
    ],
  })
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /\{\{h1\.bdy\}\} has no "bdy"/)
  assert.match(ctx.output(), /always false/)
})

test('a warning alone does not fail the command', async () => {
  const stub = await stubWith({
    ...REPORT,
    diagnostics: [{ severity: 'warning', code: 'type-error', message: 'c1: always false', nodeId: 'c1' }],
  })
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
})

test('--json prints the machine-readable report for a script to diff', async () => {
  const stub = await stubWith(REPORT)
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: { json: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(ctx.output()), REPORT)
})

test('an empty or cyclic graph says so rather than printing nothing', async () => {
  const stub = await stubWith({ workflowId: 'wf-1', order: [], nodes: {}, diagnostics: [] })
  const ctx = makeCtx(stub.api)
  const code = await types({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /empty or contains a cycle/)
})

test('types without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await types({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge types/)
})
