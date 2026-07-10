const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const approvals = require('../src/commands/approvals')
const { approve, reject } = require('../src/commands/respond')
const { ApiError } = require('../src/api')

const PENDING = [
  {
    id: 'appr-1',
    executionId: 'exec-1',
    workflowId: 'wf-1',
    workflowName: 'Production deploy',
    status: 'pending',
    message: 'Deploy v2.3.1?',
    requestedAt: '2026-07-10T09:00:00Z',
  },
]

test('approvals lists the pending inbox', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(method, 'GET')
    assert.equal(url, '/api/v1/approvals?status=pending')
    return { json: { approvals: PENDING } }
  })
  const ctx = makeCtx(stub.api)
  const code = await approvals({ positionals: [], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Production deploy/)
  assert.match(ctx.output(), /Deploy v2\.3\.1\?/)
})

test('approvals reports an empty inbox in plain language', async () => {
  const stub = await startStub(() => ({ json: { approvals: [] } }))
  const ctx = makeCtx(stub.api)
  const code = await approvals({ positionals: [], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Nothing is waiting for approval/)
})

test('approve POSTs the decision with a note', async () => {
  const stub = await startStub((method, url, body) => {
    assert.equal(method, 'POST')
    assert.equal(url, '/api/v1/approvals/appr-1/respond')
    assert.deepEqual(body, { decision: 'approve', note: 'LGTM' })
    return { json: { approval: { ...PENDING[0], status: 'approved' } } }
  })
  const ctx = makeCtx(stub.api)
  const code = await approve({ positionals: ['appr-1'], flags: { note: 'LGTM' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /approved/)
  assert.match(ctx.output(), /Production deploy/)
})

test('reject POSTs the reject decision', async () => {
  const stub = await startStub((method, url, body) => {
    assert.deepEqual(body, { decision: 'reject' })
    return { json: { approval: { ...PENDING[0], status: 'rejected' } } }
  })
  const ctx = makeCtx(stub.api)
  const code = await reject({ positionals: ['appr-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /rejected branch/)
})

test('a missing approve scope surfaces the server message', async () => {
  const stub = await startStub(() => ({
    status: 403,
    json: { error: 'This token is missing the "approve" scope' },
  }))
  const ctx = makeCtx(stub.api)
  await assert.rejects(
    () => approve({ positionals: ['appr-1'], flags: {} }, ctx),
    (err) => err instanceof ApiError && err.status === 403 && /approve/.test(err.message)
  )
  await stub.close()
})
