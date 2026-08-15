// flowforge paths <workflow-id> [--cover] [--json] — which branches an input
// can actually take, and what payload takes each one
// (GET /api/v1/workflows/:id/paths).
//
// A third kind of gate, alongside `lint` (will this run?) and `verify` (does it
// still do what its author swore it did). This one asks whether every branch on
// the canvas is *live*: a switch case sitting downstream of a condition that
// already ruled it out is wired, typed, reachable in the graph, and dead, and
// nothing else in the toolchain says so.
//
// Exits non-zero on a dead branch. `--cover` additionally fails when some live
// branch has no payload that can drive it in test mode — the stricter gate for
// a team that wants "every branch is covered by a scenario" to be a build
// rule rather than an aspiration. It is opt-in precisely because a workflow
// with an approval gate can never satisfy it: the rejected side is real and
// untestable in dry-run mode, which the output says rather than hides.

const { bold, gray, red, green, yellow, cyan } = require('../format')

const MARK = { reachable: green('✓'), unreachable: red('✗'), unknown: yellow('?') }

module.exports = async function paths(args, ctx) {
  const [workflowId] = args.positionals
  if (!workflowId) {
    ctx.log('Usage: flowforge paths <workflow-id> [--cover] [--json]')
    return 1
  }

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/paths`)

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return exitCode(report, args.flags.cover)
  }

  if (!report.analysed) {
    ctx.log(
      yellow(
        report.reason === 'cycle'
          ? '⚠ The graph contains a cycle, so no execution exists to analyse.'
          : '⚠ The graph has no nodes to analyse.'
      )
    )
    return 0
  }

  const wired = report.branches.filter((b) => b.wired > 0)
  if (wired.length === 0) {
    ctx.log(gray('No branches — this workflow makes no decisions.'))
    return 0
  }

  let current = null
  for (const branch of wired) {
    if (branch.nodeId !== current) {
      current = branch.nodeId
      ctx.log(`${bold(branch.label)} ${gray(`(${branch.nodeType})`)}`)
    }
    ctx.log(`  ${MARK[branch.status] || '?'} ${branch.outcome}${describe(branch)}`)
    if (branch.status === 'unreachable' && branch.conflict?.length) {
      ctx.log(gray(`      contradicts ${branch.conflict.join(', ')}`))
    }
    if (branch.witness && Object.keys(branch.witness.triggerData).length > 0) {
      ctx.log(gray(`      trigger: ${JSON.stringify(branch.witness.triggerData)}`))
    }
    for (const blocker of branch.blockers || []) {
      ctx.log(gray(`      ${blocker}`))
    }
  }

  ctx.log('')
  const { branches, reachable, generatable } = report.coverage
  ctx.log(
    `${reachable}/${branches} branches reachable · ` +
      `${generatable} drivable from a trigger payload`
  )
  if (report.truncated) {
    ctx.log(yellow('The search hit its bound — some branches were not decided.'))
  }
  if (generatable > 0) {
    ctx.log(gray('Write them into the suite from the canvas’s 🧪 Tests panel.'))
  }

  const dead = wired.filter((b) => b.status === 'unreachable')
  if (dead.length > 0) {
    ctx.log('')
    ctx.log(red(`${dead.length} branch${dead.length > 1 ? 'es' : ''} no input can take.`))
  }

  return exitCode(report, args.flags.cover)
}

function describe(branch) {
  if (branch.status !== 'reachable') return ''
  if (branch.generatable) return gray('  — drivable')
  return gray('  — reachable, but not from a payload')
}

// Dead branches always fail. Uncovered ones fail only under --cover, because a
// gate nobody can satisfy is a gate nobody keeps.
function exitCode(report, cover) {
  if (!report.analysed) return 0
  const wired = report.branches.filter((b) => b.wired > 0)
  if (wired.some((b) => b.status === 'unreachable')) return 1
  if (cover && wired.some((b) => !b.generatable)) return 1
  return 0
}

module.exports.exitCode = exitCode
