// flowforge exposure — which workflow to review first.
//
// The only command here that does not take a workflow id, because it is the
// only one that answers the question you have before you have one. What is
// worth testing is mostly what it declines to imply: that a called-only
// workflow scoring zero is safe, that a gated effect has been ruled out, or
// that a workflow with tests is therefore fine.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const exposure = require('../src/commands/exposure')

const row = (over = {}) => ({
  workflowId: 'wf-1',
  name: 'Order webhook',
  status: 'deployed',
  runs: { direct: 900, called: 0, perDay: 90, observedDays: 10 },
  effects: { total: 1, unconditional: 1, inherited: 0, workflows: 1, deepest: 0, unresolved: 0 },
  exposure: { floor: 90, ceiling: 90 },
  assurance: { scenarios: 0, guarantees: 0, assertions: 0, drift: false, checked: false },
  attributed: false,
  calledBy: [],
  ...over,
})

const report = (over = {}) => ({
  available: true,
  workspaceId: 'ws-1',
  windowDays: 30,
  workflows: [row()],
  queue: ['wf-1'],
  summary: {
    workflows: 1,
    unreadable: 0,
    runsPerDay: 90,
    outwardPerDay: { floor: 90, ceiling: 90 },
    unchecked: 1,
    uncheckedShare: 1,
    offCanvas: 0,
    attributed: 0,
  },
  ...over,
})

// One workspace visible, so the command can be run without an argument.
const WORKSPACES = { workspaces: [{ id: 'ws-1', name: 'Acme' }] }

async function run(payload, { flags = {}, positionals = [], workspaces = WORKSPACES } = {}) {
  const stub = await startStub((_method, path) => ({
    json: path.startsWith('/api/v1/workspaces?') || path === '/api/v1/workspaces'
      ? workspaces
      : payload,
  }))
  const ctx = makeCtx(stub.api)
  const code = await exposure({ positionals, flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('ranks the workspace and names what nothing is checking', async () => {
  const { code, out } = await run(report())
  assert.equal(code, 0)
  assert.match(out, /Where a review should start/)
  assert.match(out, /Order webhook/)
  assert.match(out, /100% of what this workspace does/)
})

test('collapses the interval when its ends agree', async () => {
  // "90" says more than "90 – 90".
  const { out } = await run(report())
  assert.ok(!out.includes('90 – 90'), out)
})

test('shows both ends when gates are doing the work', async () => {
  const { out } = await run(
    report({
      workflows: [
        row({
          effects: { total: 4, unconditional: 1, inherited: 0, workflows: 1, deepest: 0, unresolved: 0 },
          exposure: { floor: 90, ceiling: 360 },
        }),
      ],
    })
  )
  assert.match(out, /90\s*–\s*360/)
})

test('says whose consequence a called-only workflow was counted as', async () => {
  // A bare zero would read as "harmless" when it means "attributed elsewhere".
  const { out } = await run(
    report({
      workflows: [
        row({
          name: 'Send alert',
          runs: { direct: 0, called: 900, perDay: 0, observedDays: 0 },
          exposure: { floor: 0, ceiling: 0 },
          attributed: true,
          calledBy: ['Orders', 'Refunds'],
        }),
      ],
      queue: [],
      summary: { ...report().summary, unchecked: 0, uncheckedShare: 0, attributed: 1 },
    })
  )
  assert.match(out, /Send alert \(via Orders, Refunds\)/)
})

test('counts the kinds of check without summing them', async () => {
  const { out } = await run(
    report({
      workflows: [
        row({
          assurance: { scenarios: 3, guarantees: 1, assertions: 0, drift: true, checked: true },
        }),
      ],
      queue: [],
      summary: { ...report().summary, unchecked: 0, uncheckedShare: 0 },
    })
  )
  assert.match(out, /3 scenarios, 1 guarantee, drift/)
  assert.match(out, /Every workflow that does anything has something checking it/)
})

test('says how much of the workspace happens off the canvas', async () => {
  const { out } = await run(
    report({
      workflows: [
        row({
          effects: { total: 5, unconditional: 1, inherited: 4, workflows: 2, deepest: 2, unresolved: 0 },
        }),
      ],
      summary: { ...report().summary, offCanvas: 4 },
    })
  )
  assert.match(out, /4 off-canvas/)
  assert.match(out, /no single canvas shows them/)
})

test('--unchecked is the CI gate', async () => {
  assert.equal((await run(report(), { flags: { unchecked: true } })).code, 1)
})

test('--unchecked passes when everything with consequence is checked', async () => {
  const clean = report({
    workflows: [
      row({ assurance: { scenarios: 1, guarantees: 0, assertions: 0, drift: false, checked: true } }),
    ],
    queue: [],
    summary: { ...report().summary, unchecked: 0, uncheckedShare: 0 },
  })
  assert.equal((await run(clean, { flags: { unchecked: true } })).code, 0)
})

test('--top limits the table without hiding the queue', async () => {
  const many = report({
    workflows: [row(), row({ workflowId: 'wf-2', name: 'Refunds' })],
    queue: ['wf-1', 'wf-2'],
    summary: { ...report().summary, workflows: 2, unchecked: 2 },
  })
  const { out } = await run(many, { flags: { top: '1' } })
  assert.match(out, /… and 1 more/)
  // The queue is the point of the command; --top is about the table above it.
  assert.match(out, /Refunds/)
})

test('passes a window through and reports the one the server used', async () => {
  const { requests, out } = await run(report({ windowDays: 7 }), { flags: { days: '7' } })
  assert.ok(requests.some((r) => r.path.includes('days=7')), JSON.stringify(requests))
  assert.match(out, /last 7 days/)
})

test('uses the only workspace rather than demanding an argument', async () => {
  const { requests } = await run(report())
  assert.ok(requests.some((r) => r.path === '/api/v1/workspaces/ws-1/exposure'))
})

test('asks which workspace when there is more than one', async () => {
  // Guessing would be worse: the answer is about a whole workspace and the
  // wrong one looks exactly as plausible as the right one.
  const { code, out } = await run(report(), {
    workspaces: { workspaces: [{ id: 'ws-1', name: 'Acme' }, { id: 'ws-2', name: 'Beta' }] },
  })
  assert.equal(code, 1)
  assert.match(out, /Pick one/)
  assert.match(out, /Beta/)
})

test('takes an explicit workspace without listing them first', async () => {
  const { requests } = await run(report(), { positionals: ['ws-9'] })
  assert.ok(requests.every((r) => r.path !== '/api/v1/workspaces'))
  assert.ok(requests.some((r) => r.path === '/api/v1/workspaces/ws-9/exposure'))
})

test('distinguishes an empty workspace from one it could not read', async () => {
  const empty = report({
    workflows: [],
    queue: [],
    summary: { ...report().summary, workflows: 0, unchecked: 0, uncheckedShare: 0 },
  })
  assert.match((await run(empty)).out, /No workflows in this workspace/)

  const unreadable = report({
    workflows: [],
    queue: [],
    summary: { ...report().summary, workflows: 0, unreadable: 2, unchecked: 0, uncheckedShare: 0 },
  })
  assert.match((await run(unreadable)).out, /could be read \(2 unreadable\)/)
})
