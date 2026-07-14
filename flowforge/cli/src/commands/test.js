// flowforge test <workflow-id> — run a workflow's test scenarios and gate CI on
// them. POSTs to /api/v1/workflows/:id/tests/run (the dry-run suite) and exits
// non-zero when any scenario fails, so a deploy pipeline can block on "do this
// workflow's assertions still hold?". An empty suite is a skip, not a failure —
// an untested workflow isn't broken, just unverified.

const { bold, green, red, yellow, gray } = require('../format')

// A single assertion line: label with its optional description, red on failure
// (with the reason it couldn't be evaluated, if any).
function assertionLine(a) {
  const mark = a.passed ? green('✓') : red('✗')
  const desc = a.description ? gray(`  ${a.description}`) : ''
  const err = a.error ? gray(`  — ${a.error}`) : ''
  return `      ${mark} ${a.expression}${desc}${err}`
}

module.exports = async function test(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge test <workflow-id>')
    return 1
  }
  const data = await ctx.api.post(`/api/v1/workflows/${workflowId}/tests/run`)

  if (!data.total) {
    ctx.log(yellow('No test scenarios defined for this workflow.'))
    ctx.log(gray('Add scenarios in the workflow’s Tests panel, then gate CI on them here.'))
    return 0
  }

  ctx.log(bold(`Test scenarios — ${workflowId}`))
  for (const s of data.scenarios) {
    const mark = s.passed ? green('✓') : red('✗')
    const status = s.runStatus && s.runStatus !== 'completed' ? gray(`  [run ${s.runStatus}]`) : ''
    ctx.log(`  ${mark} ${s.name}${status}`)
    // Show the assertions for a failed scenario so the reason is right there.
    if (!s.passed) {
      for (const a of s.assertions) ctx.log(assertionLine(a))
    }
  }

  ctx.log('')
  if (data.ok) {
    ctx.log(green(`✓ all ${data.total} scenario${data.total === 1 ? '' : 's'} passed`))
    return 0
  }
  ctx.log(red(`✗ ${data.failed} of ${data.total} scenario${data.total === 1 ? '' : 's'} failed`))
  return 1
}
