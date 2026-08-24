// flowforge subject <identifier> [--erase] [--yes] [--reason "…"] [--workspace <id>]
//
// The two halves of a data subject request from the terminal: what is held
// about one person, and destroying it.
//
// **Previews unless `--yes`**, like `rollback` and `backfill`, and for a
// stronger reason than either: this is the one operation in the toolchain that
// cannot be undone by any other. A workflow can be redeployed and a run can be
// replayed; an erased payload is gone. So the default run prints exactly what
// would be destroyed and exits without touching anything, and the confirmation
// has to be typed.
//
// The identifier is the person's — an email, a customer id — not the
// pseudonymous key the runs are indexed by. That key is derived server-side
// from a pepper this process does not have, which is the point: the database
// holds the key and the operator holds the identifier, and neither alone
// reverses the other.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—')

// A recorded payload, shortened. The full text is in the API response for
// anybody who needs it; a terminal listing forty runs is not the place.
function preview(json, width = 60) {
  if (!json) return gray('—')
  const text = String(json).replace(/\s+/g, ' ')
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

function report(payload, ctx, { showData }) {
  const { runs, summary, subjectId } = payload

  ctx.log(bold('What is held about this person'))
  ctx.log(gray(`  indexed as ${subjectId}`))
  ctx.log('')

  if (runs.length === 0) {
    ctx.log(green('No runs are recorded against this identifier.'))
    return
  }

  ctx.log(
    table(
      runs.map((run) => ({
        when: when(run.createdAt),
        workflow: run.workflowName,
        status: run.erasedAt ? gray('erased') : run.status,
        data: run.erasedAt ? gray(`erased ${when(run.erasedAt)}`) : preview(run.trigger),
      })),
      [
        { key: 'when', label: 'WHEN' },
        { key: 'workflow', label: 'WORKFLOW' },
        { key: 'status', label: 'STATUS' },
        { key: 'data', label: showData ? 'TRIGGER PAYLOAD' : 'DATA' },
      ]
    )
  )

  const steps = runs.reduce((n, r) => n + r.steps.length, 0)
  ctx.log('')
  ctx.log(
    gray(
      `  ${summary.runs} run(s) across ${summary.workflows} workflow(s) · ` +
        `${steps} recorded step(s) · ${summary.erased} already erased` +
        (summary.oldest ? ` · oldest ${when(summary.oldest)}` : '')
    )
  )
}

module.exports = async function subject(args, ctx) {
  const identifier = args.positionals[0]
  if (!identifier) {
    ctx.log('Usage: flowforge subject <identifier> [--erase] [--yes] [--reason "…"]')
    return 1
  }

  const scope = args.flags.workspace ? { workspaceId: args.flags.workspace } : {}
  const access = await ctx.api.post('/api/v1/subjects/access', { identifier, ...scope })

  if (!access.available) {
    ctx.log('No identifier to look up.')
    return 1
  }

  if (!args.flags.erase) {
    report(access, ctx, { showData: true })
    return 0
  }

  // — erasure ————————————————————————————————————————————————————————

  const live = access.runs.filter((r) => !r.erasedAt)
  if (live.length === 0) {
    ctx.log(green('Nothing left to erase — every run recorded against this identifier is empty.'))
    return 0
  }

  if (!args.flags.yes) {
    report(access, ctx, { showData: true })
    ctx.log('')
    ctx.log(
      yellow(`This would permanently erase the recorded data of ${live.length} run(s).`) +
        '\n' +
        gray('  The runs themselves are kept, emptied — they are the proof the erasure happened.') +
        '\n' +
        gray('  Re-run with --yes to do it. Nothing has been changed.')
    )
    // Not a failure: a preview did what it was asked to.
    return 0
  }

  const result = await ctx.api.post('/api/v1/subjects/erasure', {
    identifier,
    reason: args.flags.reason || null,
    ...scope,
  })

  if (!result.available) {
    ctx.log('No identifier to erase.')
    return 1
  }

  ctx.log(bold('Erased'))
  ctx.log(`  ${result.summary.erased} run(s) emptied at ${when(result.erasedAt)}.`)
  ctx.log(`  ${gray('certificate')} ${cyan(result.certificate)}`)
  ctx.log('')
  ctx.log(
    gray('  A commitment to what was removed is recorded per run — a SHA-256 receipt, not a\n') +
      gray('  copy — and appended to the workspace audit chain, which still verifies.')
  )
  ctx.log('')
  ctx.log(
    table(
      result.commitments.map((c) => ({ run: c.executionId, digest: `${c.digest.slice(0, 16)}…` })),
      [
        { key: 'run', label: 'RUN' },
        { key: 'digest', label: 'COMMITMENT' },
      ]
    )
  )

  if (result.summary.alreadyErased > 0) {
    ctx.log('')
    ctx.log(gray(`  ${result.summary.alreadyErased} run(s) were already erased.`))
  }
  ctx.log('')
  ctx.log(
    red('  Backups are not reached by this. ') +
      gray('A snapshot taken before now still holds the payload.')
  )
  return 0
}
