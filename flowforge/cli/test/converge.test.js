// flowforge converge — where parallel branches collide.
//
// The report has two halves and only one wants attention. A collision the
// graph settles is listed as settled and costs nobody anything; a tie means
// nothing in the graph decides the value and only a human can. `--strict`
// gates on the second, never the first.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const converge = require('../src/commands/converge')

const contributor = (nodeId, label, depth, type = 'number') => ({
  nodeId, label, handle: null, depth, type,
})

const MIXED = {
  workflowId: 'wf-1',
  available: true,
  joins: [
    {
      nodeId: 'merge', label: 'Combine', type: 'output-log', arity: 2,
      mergeOrder: ['billing', 'crm'],
      collisions: [
        {
          key: 'status',
          contributors: [
            contributor('billing', 'Billing lookup', 1),
            contributor('crm', 'CRM lookup', 1),
          ],
          resolution: 'tie-break',
          decidedBy: 'crm',
          sameType: true,
        },
      ],
    },
    {
      nodeId: 'settled', label: 'Finalise', type: 'transform', arity: 2,
      mergeOrder: ['early', 'late'],
      collisions: [
        {
          key: 'total',
          contributors: [
            contributor('early', 'Subtotal', 1),
            contributor('late', 'With tax', 2),
          ],
          resolution: 'dataflow',
          decidedBy: 'late',
          sameType: true,
        },
      ],
    },
  ],
  summary: { joins: 2, collisions: 2, tieBroken: 1, dataflow: 1, typeChanging: 0 },
}

async function run(payload, flags = {}) {
  const stub = await startStub(() => ({ json: payload }))
  const ctx = makeCtx(stub.api)
  const code = await converge({ positionals: ['wf-1'], flags }, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests }
}

test('lists each collision with who supplies it and who wins', async () => {
  const { code, out } = await run(MIXED)
  assert.equal(code, 0)
  assert.match(out, /Combine\s+status\s+Billing lookup \+ CRM lookup/)
})

test('says a tie was broken alphabetically, which is the finding', async () => {
  const { out } = await run(MIXED)
  assert.match(out, /CRM lookup \(alphabetical\)/)
  assert.match(out, /tie-break/)
})

test('says a settled collision was decided by the graph, not by a sort', async () => {
  const { out } = await run(MIXED)
  assert.match(out, /With tax \(ran later\)/)
})

test('counts the two kinds separately', async () => {
  const { out } = await run(MIXED)
  assert.match(out, /2 collision\(s\) at 2 join\(s\) · 1 settled by the graph · 1 decided by a tie-break/)
})

test('exits 0 without --strict even when a tie exists', async () => {
  assert.equal((await run(MIXED)).code, 0)
})

test('exits 1 with --strict, saying what would fix it', async () => {
  const { code, out } = await run(MIXED, { strict: true })
  assert.equal(code, 1)
  assert.match(out, /1 field\(s\) are decided by nothing in the graph/)
  assert.match(out, /Order the branches, or rename one side/)
})

test('exits 0 with --strict when every collision is settled by the graph', async () => {
  const settled = {
    ...MIXED,
    joins: [MIXED.joins[1]],
    summary: { joins: 1, collisions: 1, tieBroken: 0, dataflow: 1, typeChanging: 0 },
  }
  assert.equal((await run(settled, { strict: true })).code, 0)
})

test('calls out contributors that are differently shaped', async () => {
  const shifting = {
    ...MIXED,
    joins: [
      {
        ...MIXED.joins[0],
        collisions: [
          {
            ...MIXED.joins[0].collisions[0],
            key: 'id',
            sameType: false,
            contributors: [
              contributor('billing', 'Billing lookup', 1, 'string'),
              contributor('crm', 'CRM lookup', 1, 'number'),
            ],
          },
        ],
      },
    ],
    summary: { joins: 1, collisions: 1, tieBroken: 1, dataflow: 0, typeChanging: 1 },
  }
  const { out } = await run(shifting)
  assert.match(out, /Differently shaped/)
  assert.match(out, /Combine\.id/)
  assert.match(out, /Billing lookup string/)
})

test('says plainly when a winner cannot be named', async () => {
  // Two contributors that are exclusive with the last one: which survives
  // depends on which branch ran, and naming one would be wrong.
  const ambiguous = {
    ...MIXED,
    joins: [{ ...MIXED.joins[0], collisions: [{ ...MIXED.joins[0].collisions[0], decidedBy: null }] }],
    summary: { joins: 1, collisions: 1, tieBroken: 1, dataflow: 0, typeChanging: 0 },
  }
  assert.match((await run(ambiguous)).out, /depends on the branch/)
})

test('says so plainly when nothing collides', async () => {
  const clean = {
    workflowId: 'wf-1', available: true, joins: [],
    summary: { joins: 0, collisions: 0, tieBroken: 0, dataflow: 0, typeChanging: 0 },
  }
  const { code, out } = await run(clean, { strict: true })
  assert.equal(code, 0)
  assert.match(out, /No converging branch supplies a field another one also supplies/)
})

test('passes a cyclic graph, explaining that no run of it happens', async () => {
  const { code, out } = await run({ workflowId: 'wf-1', available: false, reason: 'cycle' })
  assert.equal(code, 0)
  assert.match(out, /no run of it happens at all/)
})

test('hits the convergence endpoint for the right workflow', async () => {
  const { requests } = await run(MIXED)
  assert.equal(requests[0].path, '/api/v1/workflows/wf-1/convergence')
})

test('without a workflow id prints usage and fails', async () => {
  const ctx = makeCtx(null)
  const code = await converge({ positionals: [], flags: {} }, ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /Usage: flowforge converge/)
})
