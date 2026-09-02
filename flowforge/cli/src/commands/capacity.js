// flowforge capacity <workflow-id> [--target <ms>] [--cap N] [--days N]
//
// Is this workflow's concurrency cap the right number? `forecast` answers a
// question about one run's makespan; this one is about the queue in front of
// it. At the measured arrival rate and service time, how long does a run wait
// before it starts, and what cap would meet a target?
//
// The output leads with the calibration rather than the prediction, and that
// ordering is the point. The wait this model predicts is also *recorded* —
// `started_at − created_at` per run — so the report can be checked against the
// window it was measured from. A number that has been checked and a number that
// has not are different kinds of number, and printing them the same way would
// be the dishonest part.
//
// Exits non-zero when the queue is unstable at the current cap, or when
// `--target` is given and the cap cannot meet it. Those are the two states
// somebody wants a pipeline to notice.

const { bold, gray, green, red, yellow, cyan, table } = require('../format')

const ms = (value) => {
  if (value == null) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`
  return `${(value / 60000).toFixed(1)}m`
}

const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(0)}%`)

const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : 'an unknown time')

// The callers ungoverned traffic came through, named where there are few enough
// for a name to be useful. Past three it is a list nobody reads, so it becomes
// a count.
function callerList(callers = []) {
  if (callers.length === 0) return ''
  if (callers.length > 3) return ` from ${callers.length} other workflows`
  return ` from ${callers.map((c) => c.name).join(', ')}`
}

// How the model did against the window it was measured from. This is the line
// that says whether the rest of the output is worth acting on.
const VERDICT = {
  agrees: (c) =>
    green(`the model matches the measured wait (predicted ${ms(c.predictedMs)}, saw ${ms(c.observedMs)})`),
  'over-predicts': (c) =>
    yellow(
      `the model predicts ${ms(c.predictedMs)} but runs actually waited ${ms(c.observedMs)} — ` +
        'sizing from it will be generous'
    ),
  'under-predicts': (c) =>
    red(
      `the model predicts ${ms(c.predictedMs)} but runs actually waited ${ms(c.observedMs)} — ` +
        'something it cannot see is holding runs up'
    ),
  'no-queue-to-check': () =>
    gray('nothing queued over the window, so there is no measured wait to check against'),
  'not-enough-history': () => gray('not enough recorded waits to check the model against'),
}

function unavailable(report, ctx) {
  switch (report.reason) {
    case 'no-cap':
      ctx.log(
        'This workflow has no concurrency cap, so its runs never queue behind each other.\n' +
          gray('  Set max_concurrent_runs to have something to size.')
      )
      return 0
    case 'not-enough-runs':
      ctx.log(
        `Not enough history: ${report.runs} run(s) in the last ${report.windowDays} days, ` +
          `${report.needed} needed.\n` +
          gray('  An arrival rate measured from a handful of runs is a rumour, not a rate.')
      )
      return 0
    case 'not-governed':
      // Not a shortage of history — a shortage of history this cap has any say
      // over. Telling somebody to wait for traffic that is already arriving is
      // the wrong instruction, so this gets its own sentence.
      ctx.log(
        yellow(
          `This cap governs ${report.governance.governed} of the ` +
            `${report.governance.governed + report.governance.called} runs that reached this ` +
            `workflow in ${report.windowDays} days.`
        ) +
          '\n' +
          gray(
            '  The rest arrived as sub-workflow calls' +
              callerList(report.governance.callers) +
              '. A called run executes inside the caller\'s slot and never asks for one of\n' +
              '  this workflow\'s, so it never queues and this cap never sees it.'
          )
      )
      return 0
    case 'no-service-time':
      ctx.log('No run in the window recorded a start and a finish, so there is no service time.')
      return 0
    default:
      ctx.log('Workflow not found.')
      return 1
  }
}

module.exports = async function capacity(args, ctx) {
  const workflowId = args.positionals[0]
  if (!workflowId) {
    ctx.log('Usage: flowforge capacity <workflow-id> [--target <ms>] [--cap N] [--days N]')
    return 1
  }

  const query = []
  if (args.flags.target != null) query.push(`target=${encodeURIComponent(args.flags.target)}`)
  if (args.flags.cap != null) query.push(`cap=${encodeURIComponent(args.flags.cap)}`)
  if (args.flags.days != null) query.push(`days=${encodeURIComponent(args.flags.days)}`)
  const suffix = query.length ? `?${query.join('&')}` : ''

  const report = await ctx.api.get(`/api/v1/workflows/${workflowId}/capacity${suffix}`)
  if (!report.available) return unavailable(report, ctx)

  const { measured, current, peak, calibration, curve, recommendation, peakRecommendation, model, cap } =
    report

  ctx.log(bold(`Capacity for ${report.name}`) + gray(`  ·  cap ${cap}`))
  ctx.log(
    gray(
      `  ${measured.runs} runs over ${measured.windowDays} days · ` +
        `${measured.arrivalsPerHour.toFixed(2)}/hour arriving · ` +
        `${ms(measured.serviceMeanMs)} mean service time`
    )
  )

  // Printed above the model check, not below it, because it is a stronger
  // caveat than any of the model's own: a wait predicted accurately for a
  // tenth of the traffic is still a wait most runs never experience.
  const gov = report.governance
  if (gov && gov.called > 0) {
    ctx.log(
      yellow(
        `  ${pct(gov.share)} of the runs reaching this workflow are governed by this cap.`
      ) +
        gray(
          `\n  ${gov.called} arrived as sub-workflow calls${callerList(gov.callers)} — a called ` +
            'run executes inside the\n  caller\'s slot and never queues here. Everything below ' +
            `describes the other ${gov.governed}.`
        )
    )
  }

  // Leads, because everything below is worth exactly as much as this says.
  ctx.log('')
  ctx.log(`${bold('Model check:')} ${(VERDICT[calibration.verdict] || VERDICT['not-enough-history'])(calibration)}`)

  ctx.log('')
  if (!current.stable) {
    ctx.log(
      red(`At ${cap} slot(s) this workflow is over capacity.`) +
        '\n' +
        gray(
          `  ${pct(current.utilisation)} utilised — the backlog grows without bound, so there is ` +
            'no steady-state wait to quote.'
        )
    )
  } else {
    ctx.log(
      `At ${bold(String(cap))} slot(s): ${cyan(ms(current.waitMeanMs))} mean wait, ` +
        `${cyan(ms(current.waitP95Ms))} at p95, ${pct(current.utilisation)} utilised.`
    )
    ctx.log(
      gray(
        `  Room for ${current.headroom.toFixed(2)}× today's traffic before the queue diverges.`
      )
    )
  }

  // The variability correction, stated because a wait quoted without it is the
  // number that under-provisions.
  if (measured.cvSquaredService != null && model.variabilityFactor > 1.2) {
    ctx.log(
      gray(
        `  Service time CV² is ${measured.cvSquaredService.toFixed(1)} (1 = exponential), so the ` +
          `wait is ${model.variabilityFactor.toFixed(1)}× what M/M/c would predict ` +
          `(${ms(model.mmcWaitMeanMs)}).`
      )
    )
  }

  // The peak, which is the number the mean was hiding. Printed whenever it
  // differs materially, because a report that only ever quoted the average is
  // the report this was added to fix.
  const peakHour = peak?.hour
  if (peakHour && measured.peakHour.perHour > measured.arrivalsPerHour * 1.2) {
    ctx.log('')
    ctx.log(
      bold('At the busiest hour') +
        gray(
          ` (${measured.peakHour.runs} runs from ${when(measured.peakHour.startedAt)}, ` +
            `${measured.peakHour.perHour.toFixed(1)}/hour)`
        )
    )
    if (!peakHour.stable) {
      ctx.log(
        red(`  ${cap} slot(s) cannot absorb that.`) +
          '\n' +
          gray('  The queue grows for the duration of the burst and drains afterwards.')
      )
    } else {
      ctx.log(
        `  ${cyan(ms(peakHour.waitMeanMs))} mean wait, ${pct(peakHour.utilisation)} utilised, ` +
          `${peakHour.headroom.toFixed(2)}× headroom.`
      )
    }
  }

  ctx.log('')
  ctx.log(bold('What each cap buys'))
  ctx.log(
    table(
      curve.map((p) => ({
        slots: p.servers === cap ? `${p.servers} ${gray('(now)')}` : String(p.servers),
        used: pct(p.utilisation),
        wait: p.stable ? ms(p.waitMeanMs) : red('unstable'),
        p95: p.stable ? ms(p.waitP95Ms) : red('—'),
        headroom: p.stable ? `${p.headroom.toFixed(2)}×` : gray('—'),
      })),
      [
        { key: 'slots', label: 'SLOTS' },
        { key: 'used', label: 'USED' },
        { key: 'wait', label: 'MEAN WAIT' },
        { key: 'p95', label: 'P95' },
        { key: 'headroom', label: 'HEADROOM' },
      ]
    )
  )

  if (!recommendation) {
    return current.stable ? 0 : 1
  }

  ctx.log('')
  if (recommendation.servers == null) {
    ctx.log(
      red(`No cap reaches a mean wait of ${ms(recommendation.targetWaitMs)}.`) +
        '\n' +
        gray('  Adding slots drives the wait towards zero but never below it.')
    )
    return 1
  }

  const change = recommendation.change
  const line =
    change === 0
      ? green(`The current cap of ${cap} already meets ${ms(recommendation.targetWaitMs)}.`)
      : change > 0
        ? red(`Raise the cap to ${recommendation.servers} (+${change}) for ${ms(recommendation.targetWaitMs)}.`)
        : green(
            `A cap of ${recommendation.servers} (${change}) would still meet ` +
              `${ms(recommendation.targetWaitMs)}.`
          )
  ctx.log(line)
  // Sized separately rather than folded in, because provisioning for the
  // busiest hour of the week is a cost decision somebody else gets to make.
  // What this owes them is the number, not the choice.
  if (peakRecommendation?.servers != null && peakRecommendation.servers > recommendation.servers) {
    ctx.log(
      gray(
        `  ${peakRecommendation.servers} would meet it during the busiest hour too` +
          ` (+${peakRecommendation.change} on today's cap).`
      )
    )
  }
  if (!recommendation.confident) {
    ctx.log(
      yellow('  Treat this as a suggestion: the model does not match the measured window.')
    )
  }

  // A cap that has to grow, or a queue that is already diverging, is what a
  // pipeline wants to hear about. A cap that could shrink is a saving, not a
  // failure.
  return change > 0 || !current.stable ? 1 : 0
}
