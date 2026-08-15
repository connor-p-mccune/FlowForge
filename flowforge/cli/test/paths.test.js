// flowforge paths — the branch-feasibility gate from a terminal.
//
// Two exit codes are the product here and they are deliberately different
// gates. A dead branch always fails: either the branch or the condition above
// it is wrong. An *uncovered* branch fails only under --cover, because a
// workflow with an approval gate can never satisfy that one — the rejected side
// is real and untestable in dry-run mode — and a gate nobody can satisfy is a
// gate nobody keeps.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const paths = require('../src/commands/paths')

const branch = (nodeId, outcome, extra = {}) => ({
  nodeId,
  label: nodeId === 'route' ? 'Route' : nodeId,
  nodeType: 'switch',
  outcome,
  wired: 1,
  status: 'reachable',
  witness: { triggerData: { kind: outcome }, assumptions: [] },
  generatable: true,
  blockers: [],
  conflict: null,
  ...extra,
})

const CLEAN = {
  workflowId: 'wf-1',
  ok: true,
  analysed: true,
  truncated: false,
  branches: [branch('route', 'refund'), branch('route', 'order'), branch('route', 'default')],
  findings: [],
  scenarios: [],
  coverage: { branches: 3, reachable: 3, generatable: 3 },
}

const DEAD = {
  ...CLEAN,
  ok: false,
  branches: [
    branch('route', 'wide'),
    branch('route', 'narrow', {
      status: 'unreachable',
      witness: null,
      generatable: false,
      conflict: ['Route → wide'],
    }),
  ],
  findings: [{ severity: 'error', code: 'unreachable-branch', message: 'dead', nodeId: 'route' }],
  coverage: { branches: 2, reachable: 1, generatable: 1 },
}

const GATED = {
  ...CLEAN,
  branches: [
    branch('approve', 'true'),
    branch('approve', 'false', {
      generatable: false,
      blockers: ['test mode always takes the other side of Approve'],
    }),
  ],
  coverage: { branches: 2, reachable: 2, generatable: 1 },
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await paths({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('usage without a workflow id', async () => {
  const ctx = makeCtx(null)
  assert.equal(await paths({ positionals: [], flags: {} }, ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge paths/)
})

test('a clean workflow lists every branch with the payload that drives it', async () => {
  const { code, out, requests } = await run(CLEAN)
  assert.equal(code, 0)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/paths')
  assert.match(out, /Route/)
  assert.match(out, /refund/)
  assert.match(out, /"kind":"refund"/)
  assert.match(out, /3\/3 branches reachable/)
})

test('a dead branch fails the build and names what it contradicts', async () => {
  const { code, out } = await run(DEAD)
  assert.equal(code, 1)
  assert.match(out, /contradicts Route → wide/)
  assert.match(out, /1 branch no input can take/)
})

test('an uncoverable branch passes by default and fails under --cover', async () => {
  assert.equal((await run(GATED)).code, 0)
  const covered = await run(GATED, { cover: true })
  assert.equal(covered.code, 1)
  assert.match(covered.out, /test mode always takes the other side of Approve/)
})

test('--json prints the report and keeps the same exit code', async () => {
  const { code, out } = await run(DEAD, { json: true })
  assert.equal(code, 1)
  assert.equal(JSON.parse(out).workflowId, 'wf-1')
})

test('a graph that admits no execution is reported, not failed', async () => {
  const { code, out } = await run({ analysed: false, reason: 'cycle', branches: [], findings: [] })
  assert.equal(code, 0)
  assert.match(out, /cycle/)
})

test('a workflow with no decisions says so', async () => {
  const { code, out } = await run({
    analysed: true,
    branches: [],
    findings: [],
    coverage: { branches: 0, reachable: 0, generatable: 0 },
  })
  assert.equal(code, 0)
  assert.match(out, /makes no decisions/)
})

test('a truncated search never fails the build on its own', async () => {
  const { code, out } = await run({
    ...CLEAN,
    truncated: true,
    branches: [branch('route', 'refund', { status: 'unknown', witness: null, generatable: false })],
    coverage: { branches: 1, reachable: 0, generatable: 0 },
  })
  assert.equal(code, 0)
  assert.match(out, /hit its bound/)
})
