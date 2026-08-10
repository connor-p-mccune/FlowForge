// flowforge rollback — the preview gate and the exit codes.
//
// The command fires irreversible side effects at production systems, so the
// tests care most about what it does *without* --yes: nothing, ever, no matter
// what the run's state is.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const rollback = require('../src/commands/rollback')

const failedRun = (compensations, rollbackStatus = 'partial') => ({
  execution: {
    id: 'ex-1',
    workflowId: 'wf-1',
    status: 'failed',
    rollbackStatus,
    startedAt: '2026-03-01T09:00:00.000Z',
    finishedAt: '2026-03-01T09:00:04.000Z',
  },
  steps: [],
  compensations,
})

const COMPS = [
  { node_id: 'refund', target_node_id: 'charge', seq: 0, status: 'failed', attempts: 3, error: 'ECONNREFUSED' },
  { node_id: 'release', target_node_id: 'reserve', seq: 1, status: 'succeeded', attempts: 1, error: null },
]

test('previews the outstanding compensations and does not act without --yes', async () => {
  const stub = await startStub((method, url) =>
    method === 'GET' ? { json: failedRun(COMPS) } : { json: {} }
  )
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: ['ex-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.filter((r) => r.method === 'POST').length, 0)
  assert.match(ctx.output(), /1 compensation\(s\) outstanding/)
  assert.match(ctx.output(), /--yes/)
  // The plan names what undoes what, so the operator can see the blast radius.
  assert.match(ctx.output(), /refund/)
  assert.match(ctx.output(), /charge/)
})

test('runs the rollback with --yes and exits 0 when it completes', async () => {
  const stub = await startStub((method, url) =>
    method === 'GET'
      ? { json: failedRun(COMPS) }
      : {
        json: {
          executionId: 'ex-1',
          outcome: 'completed',
          compensations: [
            { nodeId: 'refund', targetNodeId: 'charge', status: 'succeeded', error: null },
          ],
        },
      }
  )
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: ['ex-1'], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  const post = stub.requests.find((r) => r.method === 'POST')
  assert.equal(post.path, '/api/v1/executions/ex-1/rollback')
  assert.match(ctx.output(), /Rollback completed/)
})

test('exits non-zero on a partial rollback — the world is inconsistent', async () => {
  const stub = await startStub((method) =>
    method === 'GET'
      ? { json: failedRun(COMPS) }
      : {
        json: {
          executionId: 'ex-1',
          outcome: 'partial',
          compensations: [
            { nodeId: 'refund', targetNodeId: 'charge', status: 'failed', error: 'still down' },
          ],
        },
      }
  )
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: ['ex-1'], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Rollback partial/)
  assert.match(ctx.output(), /still down/)
})

test('stops early when every compensation already succeeded', async () => {
  const done = COMPS.map((c) => ({ ...c, status: 'succeeded', error: null }))
  const stub = await startStub((method) =>
    method === 'GET' ? { json: failedRun(done, 'completed') } : { json: {} }
  )
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: ['ex-1'], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests.filter((r) => r.method === 'POST').length, 0)
  assert.match(ctx.output(), /Nothing outstanding/)
})

test('refuses a run that is not failed or cancelled', async () => {
  const stub = await startStub(() => ({
    json: { execution: { id: 'ex-1', status: 'completed' }, steps: [], compensations: [] },
  }))
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: ['ex-1'], flags: { yes: true } }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.equal(stub.requests.filter((r) => r.method === 'POST').length, 0)
  assert.match(ctx.output(), /only a failed or cancelled run/i)
})

test('requires an execution id', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await rollback({ positionals: [], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge rollback/)
})
