// flowforge debug — breakpoints as trace points.
//
// The behaviour worth pinning is the loop: poll for pauses, print what each
// node was about to do, resume it, and stop when the run settles. Each pause is
// reported exactly once however many times it is polled, because a trace that
// repeats itself is unreadable — and the exit code follows the run, like every
// other watching command.

const test = require('node:test')
const assert = require('node:assert/strict')

const { startStub, makeCtx } = require('./helpers')
const { parseArgs } = require('../src/args')
const debug = require('../src/commands/debug')

const brk = (id, nodeId, status = 'paused') => ({
  id,
  nodeId,
  nodeLabel: nodeId === 'h1' ? 'Charge card' : nodeId,
  status,
  input: { orderId: 'ord-42' },
  config: { url: 'https://api.example.com/ord-42', method: 'POST' },
})

// A stub that walks a script of break-list responses, one per poll, then
// settles the run.
function scriptedServer(script, finalStatus = 'completed') {
  let poll = 0
  const resumed = []
  const handler = (method, path, body) => {
    if (method === 'POST' && path.includes('/trigger')) {
      return { json: { execution: { id: 'exec-1', status: 'pending' } } }
    }
    if (method === 'POST' && path.includes('/resume')) {
      resumed.push({ path, body })
      return { json: { ok: true } }
    }
    if (method === 'GET' && path.endsWith('/breaks')) {
      const step = script[Math.min(poll, script.length - 1)]
      return { json: { executionId: 'exec-1', breaks: step } }
    }
    if (method === 'GET' && path.startsWith('/api/v1/executions/')) {
      poll += 1
      const done = poll >= script.length
      return { json: { execution: { id: 'exec-1', status: done ? finalStatus : 'running' } } }
    }
    return { json: {} }
  }
  return { handler, resumed }
}

async function run(argv, script, finalStatus) {
  const { handler, resumed } = scriptedServer(script, finalStatus)
  const stub = await startStub(handler)
  const ctx = makeCtx(stub.api)
  const args = parseArgs(argv)
  args.flags.interval = '0.01'
  const code = await debug(args, ctx)
  await stub.close()
  return { code, out: ctx.output(), requests: stub.requests, resumed }
}

test('starts the run with the requested breakpoints', async () => {
  const { requests } = await run(['wf-1', '--break', 'h1'], [[brk('b1', 'h1')], []])
  assert.match(requests[0].path, /\/api\/v1\/workflows\/wf-1\/trigger\?breakAt=h1/)
})

test('collects repeated --break flags rather than keeping the last', async () => {
  const { requests } = await run(['wf-1', '--break', 'h1', '--break', 'o1'], [[], []])
  assert.match(requests[0].path, /breakAt=h1%2Co1/)
})

test('--step traces every node', async () => {
  const { requests } = await run(['wf-1', '--step'], [[], []])
  assert.match(requests[0].path, /breakAt=all/)
})

test('prints what the node was about to run with, resolved', async () => {
  // The whole point: the template is already substituted, so this is the value
  // that exists nowhere else.
  const { out } = await run(['wf-1', '--break', 'h1'], [[brk('b1', 'h1')], []])
  assert.match(out, /Charge card/)
  assert.match(out, /about to run with/)
  assert.match(out, /https:\/\/api\.example\.com\/ord-42/)
  assert.match(out, /received/)
})

test('resumes each pause so the run keeps going', async () => {
  const { resumed } = await run(['wf-1', '--break', 'h1'], [[brk('b1', 'h1')], []])
  assert.equal(resumed.length, 1)
  assert.match(resumed[0].path, /\/executions\/exec-1\/breaks\/b1\/resume/)
  assert.deepEqual(resumed[0].body, { action: 'continue' })
})

test('reports each pause exactly once however often it is polled', async () => {
  // The breaks endpoint returns the whole history, so a trace that reprinted
  // settled pauses on every poll would be unreadable.
  const script = [
    [brk('b1', 'h1')],
    [brk('b1', 'h1', 'resumed'), brk('b2', 'o1')],
    [brk('b1', 'h1', 'resumed'), brk('b2', 'o1', 'resumed')],
  ]
  const { out, resumed } = await run(['wf-1', '--step'], script)
  assert.equal(out.match(/Charge card/g).length, 1)
  assert.equal(resumed.length, 2)
})

test('--stop parks the run and prints how to resume it', async () => {
  const { code, out, resumed } = await run(
    ['wf-1', '--break', 'h1', '--stop'],
    [[brk('b1', 'h1')], []]
  )
  assert.equal(code, 0)
  assert.match(out, /parked here/)
  assert.match(out, /breaks\/b1\/resume/)
  assert.equal(resumed.length, 0)
})

test('exits non-zero when the run fails', async () => {
  const { code, out } = await run(['wf-1', '--break', 'h1'], [[brk('b1', 'h1')], []], 'failed')
  assert.equal(code, 1)
  assert.match(out, /failed/)
})

test('sends --data as the trigger payload', async () => {
  const { requests } = await run(
    ['wf-1', '--break', 'h1', '--data', '{"orderId":"ord-9"}'],
    [[], []]
  )
  assert.deepEqual(requests[0].body, { orderId: 'ord-9' })
})

test('rejects malformed --data before starting anything', async () => {
  const ctx = makeCtx(null)
  const code = await debug(parseArgs(['wf-1', '--break', 'h1', '--data', '{oops']), ctx)
  assert.equal(code, 1)
  assert.match(ctx.output(), /valid JSON/)
})

test('without a breakpoint it prints usage rather than running the workflow', async () => {
  // A debug run with no breakpoints is just a run, and starting one by accident
  // from a command whose name implies inspection would be a nasty surprise.
  const ctx = makeCtx(null)
  assert.equal(await debug(parseArgs(['wf-1']), ctx), 1)
  assert.match(ctx.output(), /Usage: flowforge debug/)
  assert.equal(await debug(parseArgs([]), ctx), 1)
})
