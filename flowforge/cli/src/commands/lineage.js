// flowforge lineage <workflow-id> [--node <id>] [--json] [--strict]
//
// Where a workflow's data comes from and where it ends up.
//
// Without --node it prints the map: every node's origins, the sinks where data
// leaves, and which nodes can read each secret. With --node it answers the two
// questions someone actually has about a node they are about to change —
// *what feeds this* and *what breaks if I change it* — which is the shape of
// the question in a code review, so that is the shape of the flag.
//
// --strict exits non-zero when the analysis found something, so a pipeline can
// gate on "no caller-controlled value decides where a request goes" the same
// way `lint --strict` gates on warnings. Off by default, because a webhook that
// carries its own reply-to URL is a real and correct pattern and shouldn't fail
// anyone's build by surprise.

const { table, statusColored, gray, green, yellow, red, bold } = require('../format')

const TRUST_COLOR = { untrusted: red, external: yellow, internal: green, unknown: gray }

function paintTrust(trust, text) {
  return (TRUST_COLOR[trust] || gray)(text)
}

function printMap(ctx, report) {
  const rows = report.nodes
    .filter((n) => n.origins.length > 0)
    .map((n) => ({
      node: n.label,
      type: gray(n.nodeType ?? ''),
      from: n.origins.map((o) => paintTrust(o.trust, o.label)).join(', '),
      readBy: n.readBy.length ? String(n.readBy.length) : gray('0'),
      uses: [...n.secrets.map((s) => `secrets.${s}`), ...n.variables.map((v) => `vars.${v}`)].join(', '),
    }))
  ctx.log(bold('Dataflow'))
  ctx.log(
    table(rows, [
      { key: 'node', label: 'NODE' },
      { key: 'type', label: 'TYPE' },
      { key: 'from', label: 'DATA COMES FROM' },
      { key: 'readBy', label: 'READERS' },
      { key: 'uses', label: 'SCOPE' },
    ])
  )

  if (report.sinks.length > 0) {
    ctx.log('')
    ctx.log(bold('Where data leaves'))
    ctx.log(
      table(
        report.sinks.map((s) => ({
          node: s.label,
          what: s.what,
          sensitivity:
            s.sensitivity === 'high' ? red('high') : s.sensitivity === 'medium' ? yellow('medium') : gray('low'),
          via: s.via.map((v) => `{{${v}}}`).join(', '),
        })),
        [
          { key: 'node', label: 'NODE' },
          { key: 'what', label: 'CARRIES' },
          { key: 'sensitivity', label: 'SENSITIVITY' },
          { key: 'via', label: 'VIA' },
        ]
      )
    )
  }

  const secrets = Object.entries(report.secretReach || {})
  if (secrets.length > 0) {
    ctx.log('')
    ctx.log(bold('Secret reach'))
    for (const [name, readers] of secrets) {
      ctx.log(`  ${name}  ${gray('→')} ${readers.map((r) => r.label).join(', ')}`)
    }
  }
}

function printNode(ctx, report) {
  const { provenance, impact } = report

  ctx.log(bold(`${provenance.label} — what feeds it`))
  if (provenance.origins.length > 0) {
    for (const o of provenance.origins) {
      ctx.log(`  ${paintTrust(o.trust, o.label)}${o.detail ? gray(` — ${o.detail}`) : ''}`)
    }
  } else {
    ctx.log(gray('  nothing — this node reads no upstream data'))
  }
  // Both directions of the output/input split are worth printing when they
  // differ: an HTTP node's input traces to a webhook while its output is the
  // far side's answer, and confusing the two is how a taint finding gets
  // misread.
  const outKinds = provenance.outputOrigins.map((o) => o.kind).join(',')
  const inKinds = provenance.origins.map((o) => o.kind).join(',')
  if (outKinds && outKinds !== inKinds) {
    ctx.log(
      gray(`  (its own output is ${provenance.outputOrigins.map((o) => o.label).join(', ')})`)
    )
  }

  if (provenance.chain.length > 0) {
    ctx.log('')
    ctx.log(
      table(
        provenance.chain.map((c) => ({
          from: c.fromLabel,
          to: c.toLabel,
          reference: gray(`{{${c.reference}}}`),
          where: c.where,
        })),
        [
          { key: 'from', label: 'FROM' },
          { key: 'to', label: 'TO' },
          { key: 'reference', label: 'REFERENCE' },
          { key: 'where', label: 'IN FIELD' },
        ]
      )
    )
  }

  ctx.log('')
  ctx.log(bold(`${impact.label} — what breaks if it changes`))
  if (impact.affected.length === 0) {
    ctx.log(gray('  nothing references this node'))
  } else {
    ctx.log(
      table(
        impact.affected.map((a) => ({
          node: a.label,
          type: gray(a.nodeType ?? ''),
          hops: String(a.distance),
          via: a.references.map((r) => `{{${r.reference}}}`).join(', '),
        })),
        [
          { key: 'node', label: 'NODE' },
          { key: 'type', label: 'TYPE' },
          { key: 'hops', label: 'HOPS' },
          { key: 'via', label: 'VIA' },
        ]
      )
    )
  }

  const high = impact.sinks.filter((s) => s.sensitivity === 'high')
  if (high.length > 0) {
    ctx.log('')
    ctx.log(yellow(`Reaches ${high.length} high-sensitivity sink(s):`))
    for (const s of high) ctx.log(`  ${s.label} — ${s.what}`)
  }
}

module.exports = async function lineage(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge lineage <workflow-id> [--node <id>] [--json] [--strict]')
    return 1
  }

  const query = args.flags.node ? `?node=${encodeURIComponent(args.flags.node)}` : ''
  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/lineage${query}`)

  if (args.flags.json) {
    ctx.log(JSON.stringify(report, null, 2))
    return report.ok === false ? 1 : 0
  }

  if (report.ok === false) {
    ctx.log(red('The graph has a cycle — there is no dataflow to report.'))
    ctx.log(gray('Run `flowforge lint` for the details.'))
    return 1
  }

  if (args.flags.node) {
    printNode(ctx, report)
    return 0
  }

  printMap(ctx, report)

  const findings = report.findings || []
  if (findings.length > 0) {
    ctx.log('')
    ctx.log(bold('Findings'))
    for (const f of findings) {
      ctx.log(`  ${statusColored(f.severity === 'error' ? 'failed' : 'pending')} ${f.message}`)
    }
  } else {
    ctx.log('')
    ctx.log(green('No dataflow findings.'))
  }

  return args.flags.strict && findings.length > 0 ? 1 : 0
}
