import { useState } from 'react'
import { apiFetch } from '../../services/api'

// Are the scenarios above any good?
//
// It sits inside the Tests panel rather than getting a toolbar button of its
// own, and that placement is the argument: this is not a separate feature, it
// is the second half of the one already on screen. "Run all" says whether the
// suite passes; this says whether passing means anything.
//
// On demand, never on open. Every surviving mutant costs a full pass of the
// scenario suite, so this is a button somebody presses — a panel that started a
// hundred and sixty dry runs because it was opened would be a panel people stop
// opening.

const CAUGHT_BY = {
  lint: 'the linter',
  guarantee: 'a guarantee',
  test: 'a test',
}

export default function MutationSection({ workflowId }) {
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setReport(await apiFetch(`/api/workflows/${workflowId}/mutations`, { method: 'POST' }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const survivors = report?.available ? report.mutants.filter((m) => !m.killed) : []

  return (
    <section className="mutation">
      <div className="mutation__head">
        <span className="mutation__title">Would a bug get past these?</span>
        <button type="button" className="tests-btn" disabled={busy} onClick={run}>
          {busy ? 'Checking…' : 'Check'}
        </button>
      </div>

      <p className="mutation__lede">
        Introduces a plausible bug — a condition wired backwards, a threshold off by one,
        a gate deleted — and re-runs every check. A bug nothing catches is a gap in the
        checks, not a bug in the workflow.
      </p>

      {error && <p className="webhook-panel__error">{error}</p>}

      {report && !report.available && (
        <p className="webhook-panel__hint">
          {report.reason === 'no-mutations'
            ? 'Nothing to mutate: this workflow has no conditions, gates or removable steps.'
            : 'Nothing to mutate: the workflow is empty.'}
        </p>
      )}

      {report?.available && (
        <>
          <p
            className={`mutation__score${survivors.length > 0 ? ' mutation__score--gaps' : ' mutation__score--clean'}`}
          >
            {survivors.length === 0
              ? `Every one of the ${report.summary.total} bugs was caught.`
              : `${survivors.length} of ${report.summary.total} bugs would get through.`}
          </p>

          {survivors.length > 0 && (
            <ul className="mutation__survivors">
              {survivors.map((m) => (
                <li key={m.id}>{m.describe}</li>
              ))}
            </ul>
          )}

          {survivors.length > 0 && (
            // Actionable, because "61% covered" is not. What kills these is a
            // scenario that checks the answer rather than the exit status.
            <p className="mutation__advice">
              A scenario that asserts on what the workflow <em>decided</em> kills these; one
              that asserts only that the run completed does not.
            </p>
          )}

          {report.scenarios === 0 && report.guarantees === 0 && (
            <p className="mutation__advice mutation__advice--warn">
              This workflow has no scenarios and no guarantees, so the only thing checking
              it is the linter — and everything the linter cannot see gets through.
            </p>
          )}

          <ul className="mutation__caught">
            {report.mutants
              .filter((m) => m.killed)
              .map((m) => (
                <li key={m.id}>
                  <span className="mutation__tick" aria-hidden="true">✓</span>
                  {m.describe}
                  <em className="mutation__by"> — caught by {CAUGHT_BY[m.by] || m.by}</em>
                </li>
              ))}
          </ul>

          <p className="mutation__caveat">
            Some survivors may be <em>equivalent</em> — a mutation that cannot change
            behaviour cannot be caught by anything, and no algorithm can tell those apart.
            Each one is named so you can judge it in a second.
          </p>
        </>
      )}
    </section>
  )
}
