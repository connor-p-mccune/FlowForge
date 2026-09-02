import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// What the concurrency cap actually buys, shown beside the field where it is
// typed.
//
// The cap is a number somebody picks, and until now they picked it with nothing
// to go on. Everything needed to answer it is already recorded — how often runs
// arrive, how long each holds a slot — so this asks the server as the number
// changes and says what *that* cap gives: mean wait, and how much traffic growth
// it can absorb before the queue stops draining.
//
// Deliberately attached to the input rather than living in a panel of its own.
// The moment somebody is deciding the number is the moment the answer is worth
// having, and a report they would have to go and find is a report they will not.
//
// It never blocks the form. Anything it cannot answer — too little history, no
// cap set, a request that failed — renders as one quiet line or as nothing.

const ms = (value) => {
  if (value == null) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`
  return `${(value / 60000).toFixed(1)} min`
}

// A model that does not describe the measured window is still worth showing —
// with the caveat attached, rather than silently presenting a number that has
// failed its own check.
const CAVEAT = {
  'under-predicts': 'Runs have actually waited longer than this, so something outside the queue is holding them up.',
  'over-predicts': 'Runs have actually waited less than this, so treat it as the generous end.',
}

// The callers ungoverned traffic came through. Named while a name still helps;
// past three it is a list nobody reads.
function Callers({ callers = [] }) {
  if (callers.length === 0) return null
  if (callers.length > 3) return <> from {callers.length} other workflows</>
  return <> from {callers.map((c) => c.name).join(', ')}</>
}

export default function CapacityHint({ workflowId, cap }) {
  const [report, setReport] = useState(null)

  useEffect(() => {
    const parsed = parseInt(cap, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setReport(null)
      return undefined
    }
    // Debounced, because this fires on every keystroke in a number field.
    let live = true
    const t = setTimeout(() => {
      apiFetch(`/api/workflows/${workflowId}/capacity?cap=${parsed}`)
        .then((next) => live && setReport(next))
        .catch(() => live && setReport(null))
    }, 500)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [workflowId, cap])

  if (!report) return null

  if (!report.available) {
    // The one case that is not about history at all: there is plenty of
    // traffic, and this field has no say over it. Shown loudly rather than
    // quietly, because somebody is typing a number that will not do anything.
    if (report.reason === 'not-governed') {
      return (
        <p className="capacity-hint capacity-hint--over">
          <strong>This cap governs almost none of the traffic.</strong>{' '}
          {report.governance.called} of the{' '}
          {report.governance.called + report.governance.governed} runs in the last{' '}
          {report.windowDays} days arrived as sub-workflow calls
          <Callers callers={report.governance.callers} />, and a called run executes inside the
          caller&rsquo;s slot — it never queues here.
        </p>
      )
    }
    // Otherwise only one case is worth explaining. "No cap" is what the empty
    // field already says, and a workflow nobody has run yet does not need
    // telling.
    if (report.reason !== 'not-enough-runs') return null
    return (
      <p className="capacity-hint capacity-hint--quiet">
        Not enough history to size this yet — {report.runs} run
        {report.runs === 1 ? '' : 's'} in the last {report.windowDays} days,{' '}
        {report.needed} needed.
      </p>
    )
  }

  const { measured, current, peak, calibration, governance } = report

  // The peak is worth a sentence only when it says something the mean did not.
  // A hint that always printed two numbers would train somebody to read one.
  const burst =
    peak?.hour && measured.peakHour && measured.peakHour.perHour > measured.arrivalsPerHour * 1.5
      ? peak.hour
      : null

  if (!current.stable) {
    return (
      <p className="capacity-hint capacity-hint--over">
        <strong>{report.cap} slots cannot keep up</strong> with{' '}
        {measured.arrivalsPerHour.toFixed(1)} runs/hour at {ms(measured.serviceMeanMs)} each — the
        backlog would grow without bound, so there is no steady wait to quote.
      </p>
    )
  }

  const tight = current.headroom < 1.5
  return (
    <p className={`capacity-hint${tight ? ' capacity-hint--tight' : ''}`}>
      At {measured.arrivalsPerHour.toFixed(1)} runs/hour and {ms(measured.serviceMeanMs)} each,{' '}
      <strong>{report.cap}</strong> slot{report.cap === 1 ? '' : 's'} means a{' '}
      <strong>{ms(current.waitMeanMs)}</strong> mean wait ({ms(current.waitP95Ms)} at p95), with
      room for <strong>{current.headroom.toFixed(1)}×</strong> today&rsquo;s traffic before the
      queue stops draining.
      {burst && !burst.stable && (
        <span className="capacity-hint__caveat">
          {' '}At its busiest hour ({measured.peakHour.perHour.toFixed(0)} runs/hour) this cap
          cannot keep up — the queue grows through the burst and drains afterwards.
        </span>
      )}
      {burst && burst.stable && (
        <span className="capacity-hint__caveat">
          {' '}At its busiest hour ({measured.peakHour.perHour.toFixed(0)} runs/hour) that becomes
          a {ms(burst.waitMeanMs)} wait.
        </span>
      )}
      {CAVEAT[calibration.verdict] && (
        <span className="capacity-hint__caveat"> {CAVEAT[calibration.verdict]}</span>
      )}
      {/* A stronger caveat than any the model makes about itself: the sentence
          above can be exactly right about a queue most of the traffic is not
          in. */}
      {governance?.called > 0 && (
        <span className="capacity-hint__caveat">
          {' '}That describes {Math.round(governance.share * 100)}% of the runs reaching this
          workflow — the other {governance.called} arrived as sub-workflow calls
          <Callers callers={governance.callers} />, which never queue here.
        </span>
      )}
    </p>
  )
}
