// flowforge debug <workflow-id> --break <node-id> — run a workflow with
// breakpoints and report what each one was about to do.
//
// The terminal cannot offer the canvas's version of a debugger, because there
// is nobody sitting at a prompt in a CI job. What it can offer is the more
// useful half for a script: a breakpoint that is polled, printed, and
// immediately resumed is a **trace point**. The run reports exactly what each
// named node was about to send — templates already substituted, secrets already
// redacted — in the order it reached them.
//
// That answers a question log nodes answer badly. "Why did the staging run post
// *that* body?" normally means editing the workflow to add an output node,
// deploying it, running it, reading it, and taking it out again — which changes
// the thing being investigated. This changes nothing about the graph.
//
// --step traces every node instead of named ones. --stop pauses at the first
// breakpoint and leaves the run parked there, printing the id to resume with,
// for when a person really does want to hold it open. Exits non-zero unless the
// run completed, like every other watching command.

const { bold, gray, red, green, yellow, cyan, statusColored } = require('../format')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

module.exports = async function debug(args, ctx) {
  const [workflowId] = args.positionals
  const breaks = [].concat(args.flags.break || []).filter((v) => typeof v === 'string')
  const stepAll = args.flags.step === true

  if (!workflowId || (breaks.length === 0 && !stepAll)) {
    ctx.log('Usage: flowforge debug <workflow-id> --break <node-id> [--break <node-id>] [--step] [--stop] [--data <json>]')
    ctx.log(gray('  --step traces every node; --stop parks the run at the first break instead of continuing'))
    return 1
  }

  let payload = {}
  if (args.flags.data) {
    try {
      payload = JSON.parse(args.flags.data)
    } catch {
      ctx.log(red('--data must be valid JSON'))
      return 1
    }
  }

  const breakAt = stepAll ? 'all' : breaks.join(',')
  const started = await ctx.api.post(
    `/api/v1/workflows/${workflowId}/trigger?breakAt=${encodeURIComponent(breakAt)}`,
    payload
  )
  const executionId = started.execution.id
  ctx.log(`${gray('run')} ${bold(executionId)}`)
  ctx.log('')

  const seen = new Set()
  const pollMs = Number(args.flags.interval) > 0 ? Number(args.flags.interval) * 1000 : 1000
  // Generous, because a paused run is waiting on this loop and the server's own
  // break timeout is the real bound on how long that can last.
  const deadline = Date.now() + (Number(args.flags.timeout) > 0 ? Number(args.flags.timeout) : 900) * 1000

  for (;;) {
    const { breaks: list } = await ctx.api.get(`/api/v1/executions/${executionId}/breaks`)

    for (const brk of list) {
      if (seen.has(brk.id)) continue
      seen.add(brk.id)
      printBreak(ctx, brk)

      if (brk.status !== 'paused') continue
      if (args.flags.stop) {
        ctx.log(yellow('  ⏸ parked here'))
        ctx.log(
          gray(
            `  resume: POST /api/v1/executions/${executionId}/breaks/${brk.id}/resume {"action":"continue"}`
          )
        )
        return 0
      }
      await ctx.api.post(`/api/v1/executions/${executionId}/breaks/${brk.id}/resume`, {
        action: 'continue',
      })
    }

    const { execution } = await ctx.api.get(`/api/v1/executions/${executionId}`)
    if (TERMINAL.has(execution.status)) {
      ctx.log('')
      ctx.log(`${bold('status')} ${statusColored(execution.status)}`)
      if (execution.error) ctx.log(red(`  ${execution.error}`))
      return execution.status === 'completed' ? 0 : 1
    }

    if (Date.now() > deadline) {
      ctx.log(red('Timed out waiting for the run to finish.'))
      return 1
    }
    await sleep(pollMs)
  }
}

function printBreak(ctx, brk) {
  ctx.log(`${cyan('▸')} ${bold(brk.nodeLabel || brk.nodeId)} ${gray(`(${brk.nodeId})`)}`)
  // The config is the interesting half — it is what the node was about to *do*,
  // with every {{…}} already resolved, which exists nowhere else.
  if (brk.config != null) printJson(ctx, 'about to run with', brk.config)
  if (brk.input != null) printJson(ctx, 'received', brk.input)
  if (brk.status !== 'paused' && brk.status !== 'resumed') {
    ctx.log(`  ${yellow(brk.status)}`)
  }
  ctx.log('')
}

function printJson(ctx, label, value) {
  const text = JSON.stringify(value, null, 2)
  ctx.log(gray(`  ${label}:`))
  for (const line of text.split('\n')) ctx.log(`    ${line}`)
}
