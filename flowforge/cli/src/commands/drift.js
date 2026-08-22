// flowforge drift <workflow-id> [--strict] — has what this workflow's nodes
// *produce* changed?
//
// Output drift, not definition drift. `flowforge diff` answers whether the live
// graph still matches the document in git; this answers whether the data still
// looks like the data — which is the failure every other check in this CLI is
// blind to. `lint`, `verify`, `paths` and `types` all reason about the graph;
// `check` and `regressions` reason about durations and outcomes. None of them
// would notice an upstream API quietly starting to send nulls, because every run
// still completes and every step still succeeds.
//
// Reporting by default, `--strict` to fail the build on a major finding. Same
// split as `preview`, and for the same reason: most changes in data are
// expected, and a check that fails on every one of them is a check somebody
// disables.

const { bold, gray, red, yellow, green, table } = require('../format')

const KIND_LABEL = {
  'field-missing': 'gone',
  'field-added': 'new',
  presence: 'presence',
  'null-rate': 'nulls',
  'type-changed': 'type',
  distribution: 'values',
  categories: 'mix',
}

// The evidence behind a finding, as one short parenthetical. A finding somebody
// has to go and verify is not a finding.
function evidence(finding) {
  const d = finding.detail || {}
  if (d.test === 'kolmogorov-smirnov') return `D=${d.d.toFixed(2)}, p=${d.pValue.toExponential(1)}`
  if (d.test === 'population-stability-index') return `PSI=${d.psi.toFixed(2)}`
  if (d.test === 'two-proportion') return `p=${d.pValue.toExponential(1)}`
  if (d.test === 'dominant-type') return `${d.baselineType} → ${d.recentType}`
  return ''
}

module.exports = async function drift(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge drift <workflow-id> [--strict] [--recent N] [--baseline N]')
    return 1
  }
  const params = []
  if (args.flags.recent) params.push(`recent=${encodeURIComponent(args.flags.recent)}`)
  if (args.flags.baseline) params.push(`baseline=${encodeURIComponent(args.flags.baseline)}`)
  const query = params.length ? `?${params.join('&')}` : ''
  const data = await ctx.api.get(`/api/v1/workflows/${workflowId}/drift${query}`)

  if (!data.available) {
    if (data.reason === 'insufficient-history') {
      ctx.log(
        gray(`Not enough history yet — ${data.have} completed runs, ${data.needed} needed to compare two windows.`)
      )
      // Not a failure. A check that fails every young workflow's build is a
      // check somebody removes.
      return 0
    }
    ctx.log(gray('No drift report available for this workflow.'))
    return 0
  }

  const { summary, window, nodes } = data
  ctx.log(
    bold('Output drift') +
      gray(`  (last ${window.recent.runs} runs vs the ${window.baseline.runs} before them)`)
  )

  const findings = nodes.flatMap((n) => n.findings)
  if (findings.length === 0) {
    ctx.log(green('  No change detected.'))
  } else {
    for (const node of nodes) {
      if (node.findings.length === 0) continue
      ctx.log('')
      ctx.log(`  ${bold(node.nodeLabel)} ${gray(`(${node.nodeType ?? '?'})`)}`)
      ctx.log(
        table(
          node.findings.map((f) => ({
            sev: f.severity === 'major' ? red('major') : yellow('minor'),
            what: KIND_LABEL[f.kind] || f.kind,
            path: f.path,
            summary: f.summary,
            evidence: gray(evidence(f)),
          })),
          [
            { key: 'sev', label: '' },
            { key: 'what', label: 'CHANGE' },
            { key: 'path', label: 'FIELD' },
            { key: 'summary', label: 'DETAIL' },
            { key: 'evidence', label: 'EVIDENCE' },
          ]
        )
      )
    }
  }

  // Coverage, always — a report that hides what it could not compare is
  // claiming a completeness it does not have.
  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.fieldsCompared} fields compared across ${summary.nodesCompared} nodes` +
        (summary.fieldsSkipped ? `, ${summary.fieldsSkipped} skipped (too few samples, identifier-like, or redacted)` : '')
    )
  )

  if (args.flags.strict && summary.major > 0) {
    ctx.log(red(`\n${summary.major} major ${summary.major === 1 ? 'change' : 'changes'} in what this workflow produces.`))
    return 1
  }
  return 0
}
