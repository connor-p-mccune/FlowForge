// flowforge merge — the preview gate, the conflict exit code, and the flags.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { startStub, makeCtx } = require('./helpers')
const merge = require('../src/commands/merge')

const DOC = {
  exportVersion: '1.0',
  name: 'Sync',
  graph_data: {
    nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 't1' } }],
    edges: [],
  },
}

function writeDoc(contents = DOC) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-merge-')), 'sync.json')
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  return file
}

const CLEAN = {
  workflowId: 'wf-1',
  clean: true,
  applied: false,
  base: { versionId: 'v1', version: 3 },
  conflicts: [],
  droppedEdges: [],
  summary: { added: 1, removed: 0, changed: 2, unchanged: 4, conflicts: 0, nodes: 7, edges: 6 },
  lint: { errors: 0, warnings: 1, issues: [] },
}

const CONFLICTED = {
  ...CLEAN,
  clean: false,
  conflicts: [
    {
      kind: 'field',
      nodeId: 'h1',
      label: 'Charge card',
      field: 'config.url',
      description: 'Charge card · config.url: live "https://live/x" vs document "https://git/x"',
    },
  ],
  summary: { ...CLEAN.summary, conflicts: 1 },
  lint: null,
}

test('previews without applying and names the base', async () => {
  const stub = await startStub(() => ({ json: CLEAN }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc()], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].body.apply, false)
  assert.equal(stub.requests[0].body.strategy, 'manual')
  assert.match(ctx.output(), /against version 3/)
  assert.match(ctx.output(), /Merges cleanly/)
  assert.match(ctx.output(), /--yes/)
})

test('--yes applies and says the deploy is still a separate act', async () => {
  const stub = await startStub(() => ({ json: { ...CLEAN, applied: true } }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc()], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].body.apply, true)
  assert.match(ctx.output(), /Merged into the live workflow/)
  assert.match(ctx.output(), /Deploy when you/)
})

test('conflicts exit 2 — a merge needing a person is not a broken command', async () => {
  const stub = await startStub(() => ({ json: CONFLICTED }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc()], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 2)
  assert.match(ctx.output(), /1 conflict — nothing was written/)
  assert.match(ctx.output(), /Charge card · config\.url/)
  assert.match(ctx.output(), /--ours/)
  assert.match(ctx.output(), /--theirs/)
})

test('--ours and --theirs forward a strategy; both together is refused', async () => {
  const oursStub = await startStub(() => ({ json: CLEAN }))
  const oursCtx = makeCtx(oursStub.api)
  await merge({ positionals: ['wf-1', writeDoc()], flags: { ours: true } }, oursCtx)
  await oursStub.close()
  assert.equal(oursStub.requests[0].body.strategy, 'ours')

  const theirsStub = await startStub(() => ({ json: CLEAN }))
  const theirsCtx = makeCtx(theirsStub.api)
  await merge({ positionals: ['wf-1', writeDoc()], flags: { theirs: true } }, theirsCtx)
  await theirsStub.close()
  assert.equal(theirsStub.requests[0].body.strategy, 'theirs')

  const bothStub = await startStub(() => ({ json: CLEAN }))
  const bothCtx = makeCtx(bothStub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc()], flags: { ours: true, theirs: true } }, bothCtx)
  await bothStub.close()
  assert.equal(code, 1)
  assert.equal(bothStub.requests.length, 0)
})

test('--base forwards the version to merge against', async () => {
  const stub = await startStub(() => ({ json: CLEAN }))
  const ctx = makeCtx(stub.api)
  await merge({ positionals: ['wf-1', writeDoc()], flags: { base: '2' } }, ctx)
  await stub.close()
  assert.equal(stub.requests[0].body.baseVersion, '2')
})

test('reports a merged graph that lints with errors, and fails', async () => {
  const stub = await startStub(() => ({
    json: {
      ...CLEAN,
      applied: true,
      lint: {
        errors: 1,
        warnings: 0,
        issues: [{ severity: 'error', code: 'unknown-node-ref', message: 'Log: {{h1…}} references a node that doesn’t exist' }],
      },
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc()], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /references a node that doesn/)
})

test('reports dropped connections rather than deleting them quietly', async () => {
  const stub = await startStub(() => ({
    json: {
      ...CLEAN,
      droppedEdges: [{ source: 't1', target: 'h1', sourceHandle: null, reason: 'an endpoint was removed by the merge' }],
    },
  }))
  const ctx = makeCtx(stub.api)
  await merge({ positionals: ['wf-1', writeDoc()], flags: {} }, ctx)
  await stub.close()
  assert.match(ctx.output(), /t1 → h1 dropped/)
})

test('rejects a file that is not a workflow export', async () => {
  const stub = await startStub(() => ({ json: CLEAN }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1', writeDoc({ nope: true })], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
  assert.match(ctx.output(), /not a workflow export/)
})

test('merge without both arguments prints usage and fails', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await merge({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge merge/)
})
