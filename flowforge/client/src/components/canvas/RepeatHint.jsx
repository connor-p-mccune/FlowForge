import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// What happens twice, shown beside the setting that claims it doesn't.
//
// The recovery dropdown's middle option reads "Always continue — this
// workflow's steps are idempotent", and its hint says *only choose this when
// repeating one is harmless — a fetch, not a charge*. That is an assertion
// about the graph, made in a dropdown, by somebody who cannot be expected to
// re-audit fifteen nodes before choosing. The graph can answer it.
//
// Two findings, and they are independent.
//
// The first has nothing to do with the setting: the engine retries most nodes
// three times on every run, so a step whose repeat is unsafe repeats on an
// ordinary timeout with no worker having died at all. That is shown whatever
// the policy says, because changing the policy does not change it.
//
// The second is the claim check, and it is judged against the option **on
// screen** rather than the one the server read. Somebody selecting `resume` is
// exactly who needs to be told, and telling them only after they save would be
// telling them too late.

export default function RepeatHint({ workflowId, policy }) {
  const [report, setReport] = useState(null)

  useEffect(() => {
    if (!workflowId) return undefined
    let live = true
    apiFetch(`/api/workflows/${workflowId}/repeats`)
      .then((next) => live && setReport(next))
      .catch(() => live && setReport(null))
    return () => {
      live = false
    }
  }, [workflowId])

  if (!report?.available || report.steps.length === 0) return null

  const { summary, steps } = report
  const retried = steps.filter(
    (s) => s.retried && (s.verdict === 'unsafe' || s.verdict === 'unknown')
  )
  // Judged here rather than read from report.recovery, which describes the
  // saved policy. The dropdown is what the author is deciding right now.
  const contradicted = policy === 'resume' && summary.unsafe > 0
  const unsafeNames = steps.filter((s) => s.verdict === 'unsafe').map((s) => s.label)

  if (retried.length === 0 && !contradicted) {
    return (
      <p className="repeat-hint repeat-hint--clear">
        Nothing this workflow does would repeat its work if a step ran twice.
      </p>
    )
  }

  return (
    <>
      {retried.length > 0 && (
        <p className="repeat-hint repeat-hint--warn">
          <strong>
            {retried.length} step{retried.length === 1 ? '' : 's'} would repeat their work on an
            ordinary retry
          </strong>{' '}
          — {retried.map((s) => s.label).join(', ')}. The engine retries most nodes{' '}
          {summary.maxAttempts} times, and a retry fires on a timeout: the case where the far side
          may already have done the work. Nothing has to crash for this.
        </p>
      )}
      {contradicted && (
        <p className="repeat-hint repeat-hint--warn">
          <strong>This workflow&rsquo;s steps are not all idempotent.</strong>{' '}
          {unsafeNames.length} of them would do their work again if repeated —{' '}
          {unsafeNames.slice(0, 4).join(', ')}
          {unsafeNames.length > 4 ? `, and ${unsafeNames.length - 4} more` : ''}.
        </p>
      )}
      <p className="repeat-hint repeat-hint--quiet">
        An HTTP node whose endpoint deduplicates can say so — tick{' '}
        <em>idempotent</em> on it and every attempt carries the same{' '}
        <code>Idempotency-Key</code>, which is what lets a lost run continue safely.
      </p>
    </>
  )
}
