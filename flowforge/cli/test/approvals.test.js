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

// Quorum gates: a response that does not settle the gate must not read as a
// decision. A script inferring "approved" from a successful call would act on a
// half-met quorum, which is the precise thing four-eyes exists to prevent.
test('approve reports progress when the quorum is not yet met', async () => {
  const stub = await startStub(() => ({
    status: 202,
    json: {
      approval: { id: 'ap-1', workflowName: 'Refunds', status: 'pending' },
      progress: { settled: false, status: 'pending', approvals: 1, needed: 3 },
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await approve({ positionals: ['ap-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /recorded/)
  assert.match(ctx.output(), /1 of 3 approvals for "Refunds"/)
  assert.match(ctx.output(), /still waiting/)
  assert.ok(!/continues down/.test(ctx.output()))
})

test('approve reports the decision once the quorum is met', async () => {
  const stub = await startStub(() => ({
    json: {
      approval: { id: 'ap-1', workflowName: 'Refunds', status: 'approved' },
      progress: { settled: true, status: 'approved', approvals: 3, needed: 3 },
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await approve({ positionals: ['ap-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /approved/)
  assert.match(ctx.output(), /continues down the approved branch/)
})

test('the inbox names what a gate requires, and only when it requires something', async () => {
  const withQuorum = await startStub(() => ({
    json: {
      approvals: [
        {
          id: 'ap-1', workflowName: 'Refunds', message: 'Over 10k', status: 'pending',
          requestedAt: '2026-03-01T09:00:00.000Z',
          quorum: 2, requiredRole: 'owner', separationOfDuties: true,
        },
      ],
    },
  }))
  const quorumCtx = makeCtx(withQuorum.api)
  await approvals({ positionals: [], flags: {} }, quorumCtx)
  await withQuorum.close()
  assert.match(quorumCtx.output(), /REQUIRES/)
  assert.match(quorumCtx.output(), /2 approvals · owner · not the requester/)

  const plain = await startStub(() => ({
    json: {
      approvals: [
        { id: 'ap-2', workflowName: 'Refunds', message: '', status: 'pending', requestedAt: '2026-03-01T09:00:00.000Z' },
      ],
    },
  }))
  const plainCtx = makeCtx(plain.api)
  await approvals({ positionals: [], flags: {} }, plainCtx)
  await plain.close()
  // An always-present, usually-empty column is noise in a terminal.
  assert.ok(!/REQUIRES/.test(plainCtx.output()))
})
