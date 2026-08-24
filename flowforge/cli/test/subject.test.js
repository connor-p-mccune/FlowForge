// flowforge subject — a data subject request from the terminal.
//
// The behaviour that matters is the default one: it previews. This is the only
// operation in the toolchain that no other can undo — a workflow can be
// redeployed and a run replayed, but an erased payload is gone — so the plain
// run prints what would be destroyed and touches nothing.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const subject = require('../src/commands/subject')

const run = (id, over = {}) => ({
  executionId: id,
  workflowId: 'wf-1',
  workflowName: 'Orders',
  status: 'completed',
  triggerType: 'webhook',
  createdAt: '2026-08-01T10:00:00.000Z',
  finishedAt: '2026-08-01T10:00:04.000Z',
  erasedAt: null,
  trigger: '{"customer":{"email":"alice@example.com","name":"Alice"}}',
  steps: [{ nodeId: 'ship', nodeType: 'action-http', status: 'succeeded', input: '{}', output: '{}' }],
  ...over,
})

const ACCESS = {
  available: true,
  workspaceId: 'ws-1',
  subjectId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  runs: [run('ex-1'), run('ex-2')],
  summary: { runs: 2, erased: 0, workflows: 1, oldest: '2026-07-20T09:00:00.000Z' },
}

const CERT = {
  available: true,
  workspaceId: 'ws-1',
  certificate: '5f8c1e2a-0b3d-4c5e-8a9f-1b2c3d4e5f60',
  subjectId: ACCESS.subjectId,
  erasedAt: '2026-08-22T12:00:00.000Z',
  runs: ['ex-1', 'ex-2'],
  commitments: [
    { executionId: 'ex-1', digest: 'a'.repeat(64) },
    { executionId: 'ex-2', digest: 'b'.repeat(64) },
  ],
  summary: { erased: 2, alreadyErased: 0 },
}

// Routes by path so one stub can answer both calls the erase flow makes.
async function go(flags = {}, { access = ACCESS, cert = CERT } = {}) {
  const stub = await startStub((method, url) => ({
    json: url.endsWith('/erasure') ? cert : access,
  }))
  const ctx = makeCtx(stub.api)
  const code = await subject({ positionals: ['alice@example.com'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists what is held about one person', async () => {
  const { code, out } = await go()
  assert.equal(code, 0)
  assert.match(out, /What is held about this person/)
  assert.match(out, /2 run\(s\) across 1 workflow\(s\)/)
  assert.match(out, /alice@example\.com/)
})

test('shows the pseudonymous key the runs are indexed by', async () => {
  const { out } = await go()
  assert.match(out, /indexed as a1b2c3d4e5f60718293a4b5c6d7e8f90/)
})

test('sends the identifier in a body, never in the path', async () => {
  // It is personal data, and a URL ends up in query logs and proxy logs.
  const { requests } = await go()
  assert.equal(requests[0].path, '/api/v1/subjects/access')
  assert.equal(requests[0].body.identifier, 'alice@example.com')
})

test('says so plainly when nothing is held', async () => {
  const empty = { ...ACCESS, runs: [], summary: { runs: 0, erased: 0, workflows: 0, oldest: null } }
  const { code, out } = await go({}, { access: empty })
  assert.equal(code, 0)
  assert.match(out, /No runs are recorded against this identifier/)
})

test('marks a run that was already erased instead of showing empty data', async () => {
  const mixed = {
    ...ACCESS,
    runs: [run('ex-1'), run('ex-2', { erasedAt: '2026-08-10T08:00:00.000Z', trigger: null, steps: [] })],
    summary: { runs: 2, erased: 1, workflows: 1, oldest: '2026-07-20T09:00:00.000Z' },
  }
  const { out } = await go({}, { access: mixed })
  assert.match(out, /erased 2026-08-10 08:00:00/)
  assert.match(out, /1 already erased/)
})

// — the default that matters ————————————————————————————————————————

test('--erase without --yes previews and changes nothing', async () => {
  const { code, out, requests } = await go({ erase: true })
  assert.equal(code, 0)
  assert.match(out, /would permanently erase the recorded data of 2 run\(s\)/)
  assert.match(out, /Re-run with --yes/)
  assert.match(out, /Nothing has been changed/)
  // One call — the read. No erasure was requested.
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/api/v1/subjects/access')
})

test('the preview explains why the runs are kept', async () => {
  const { out } = await go({ erase: true })
  assert.match(out, /kept, emptied — they are the proof the erasure happened/)
})

test('--erase --yes erases and prints the certificate', async () => {
  const { code, out, requests } = await go({ erase: true, yes: true, reason: 'Ticket 4821' })
  assert.equal(code, 0)
  assert.match(out, /2 run\(s\) emptied/)
  assert.match(out, /5f8c1e2a-0b3d-4c5e-8a9f-1b2c3d4e5f60/)
  assert.equal(requests[1].path, '/api/v1/subjects/erasure')
  assert.equal(requests[1].body.reason, 'Ticket 4821')
})

test('prints a commitment per run, truncated to something readable', async () => {
  const { out } = await go({ erase: true, yes: true })
  assert.match(out, /COMMITMENT/)
  assert.match(out, /aaaaaaaaaaaaaaaa…/)
})

test('says the receipt is a hash and not a copy', async () => {
  const { out } = await go({ erase: true, yes: true })
  assert.match(out, /SHA-256 receipt, not a/)
  assert.match(out, /still verifies/)
})

test('says plainly that backups are not reached', async () => {
  // The limit stated rather than glossed: claiming otherwise would be the one
  // dishonest sentence in the whole feature.
  const { out } = await go({ erase: true, yes: true })
  assert.match(out, /Backups are not reached by this/)
})

test('does nothing when every run is already erased', async () => {
  const done = {
    ...ACCESS,
    runs: [run('ex-1', { erasedAt: '2026-08-10T08:00:00.000Z', trigger: null, steps: [] })],
    summary: { runs: 1, erased: 1, workflows: 1, oldest: null },
  }
  const { code, out, requests } = await go({ erase: true, yes: true }, { access: done })
  assert.equal(code, 0)
  assert.match(out, /Nothing left to erase/)
  assert.equal(requests.length, 1)
})

test('passes an explicit workspace through to both calls', async () => {
  const { requests } = await go({ erase: true, yes: true, workspace: 'ws-9' })
  assert.equal(requests[0].body.workspaceId, 'ws-9')
  assert.equal(requests[1].body.workspaceId, 'ws-9')
})

test('without an identifier prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await subject({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge subject/)
})
