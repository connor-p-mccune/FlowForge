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
    // Only the case worth explaining. "No cap" is what the empty field already
    // says, and a workflow nobody has run yet does not need telling.
    if (report.reason !== 'not-enough-runs') return null
    return (
      <p className="capacity-hint capacity-hint--quiet">
        Not enough history to size this yet — {report.runs} run
        {report.runs === 1 ? '' : 's'} in the last {report.windowDays} days,{' '}
        {report.needed} needed.
      </p>
    )
  }

  const { measured, current, calibration } = report

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
      {CAVEAT[calibration.verdict] && (
        <span className="capacity-hint__caveat"> {CAVEAT[calibration.verdict]}</span>
      )}
    </p>
  )
}
