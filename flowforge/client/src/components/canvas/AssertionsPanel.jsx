import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// Things this workflow says must never happen, and whether they have.
//
// The sibling of 🛡 Guarantees, and the split between them is the point.
// Guarantees are proved over the *graph* — statically, before anything runs.
// These are checked against the runs that actually happened, which is the only
// way to reach a property about data or an outcome.
//
// Every design choice here follows from one belief about how somebody arrives:
// they do not sit down to write assertions. They notice something went wrong,
// go looking for it with a query, and *then* want it never to happen again. So
// the panel says that out loud, points at the query surface, and takes the same
// string back — an assertion is a query you pinned.
//
// The state a lesser panel would get wrong is `broken`. An assertion whose
// predicate throws on every run has zero violations, and showing it as green
// beside the ones that work would be actively misleading. It gets its own
// colour, its own error message, and is never counted among the holding.

const STATE_META = {
  holding: { icon: '✓', label: 'Holding', className: 'assertion--holding' },
  violated: { icon: '✗', label: 'Violated', className: 'assertion--violated' },
  broken: { icon: '!', label: 'Never evaluated', className: 'assertion--broken' },
  unchecked: { icon: '·', label: 'No runs yet', className: 'assertion--unchecked' },
}

export default function AssertionsPanel({ workflowId, onClose }) {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [composing, setComposing] = useState(false)
  const [name, setName] = useState('')
  const [predicate, setPredicate] = useState('')
  const [formError, setFormError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setError(null)
      setReport(await apiFetch(`/api/workflows/${workflowId}/assertions`))
    } catch (err) {
      setError(err.message)
    }
  }, [workflowId])

  useEffect(() => {
    load()
  }, [load])

  async function pin(e) {
    e.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      await apiFetch(`/api/workflows/${workflowId}/assertions`, {
        method: 'POST',
        body: { name: name.trim(), predicate: predicate.trim() },
      })
      setName('')
      setPredicate('')
      setComposing(false)
      await load()
    } catch (err) {
      // A predicate that does not parse is refused rather than stored, and the
      // message says why — a stored one that cannot be evaluated would be
      // silently green forever.
      setFormError(err.body?.error || err.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    try {
      await apiFetch(`/api/assertions/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function toggle(assertion) {
    try {
      await apiFetch(`/api/assertions/${assertion.id}`, {
        method: 'PUT',
        body: { enabled: !assertion.enabled },
      })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const list = report?.assertions || []
  const summary = report?.summary

  return (
    <aside className="issues-panel" aria-label="Run assertions">
      <div className="issues-panel__header">
        <span className="issues-panel__title">⛔ Must never happen</span>
        {summary && summary.total > 0 && (
          <span className="issues-panel__counts">
            {summary.violated > 0 && (
              <span className="issues-panel__count issues-panel__count--error">
                {summary.violated} violated
              </span>
            )}
            {summary.broken > 0 && (
              <span className="issues-panel__count issues-panel__count--warning">
                {summary.broken} broken
              </span>
            )}
          </span>
        )}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}
        {!error && report === null && <p className="issues-panel__hint">Loading…</p>}

        {report && list.length === 0 && !composing && (
          <>
            <p className="assertions__lede">
              Guarantees prove what the <em>graph</em> can do. These check what the{' '}
              <em>runs</em> did — the failures about data and outcomes that no amount of
              graph analysis reaches.
            </p>
            <p className="assertions__lede assertions__lede--quiet">
              Find the runs you never want to see again with the search on the run history
              tab, then pin that same expression here.
            </p>
          </>
        )}

        {list.length > 0 && (
          <ul className="assertion-list">
            {list.map((assertion) => {
              const meta = STATE_META[assertion.state] || STATE_META.unchecked
              return (
                <li key={assertion.id} className={`assertion ${meta.className}`}>
                  <div className="assertion__head">
                    <span className="assertion__icon" title={meta.label} aria-hidden="true">
                      {meta.icon}
                    </span>
                    <span className="assertion__name">
                      {assertion.name}
                      {!assertion.enabled && <em className="assertion__off"> (off)</em>}
                    </span>
                    <button
                      className="assertion__action"
                      title={assertion.enabled ? 'Stop checking this' : 'Start checking this again'}
                      onClick={() => toggle(assertion)}
                    >
                      {assertion.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="assertion__action assertion__action--remove"
                      title="Remove"
                      onClick={() => remove(assertion.id)}
                    >
                      Remove
                    </button>
                  </div>

                  <code className="assertion__predicate">{assertion.predicate}</code>

                  <div className="assertion__meta">
                    {assertion.state === 'broken' ? (
                      // Zero violations because it has never worked. Saying so
                      // is the only honest thing to put here.
                      <span className="assertion__broken">
                        Threw on all {assertion.errors} run{assertion.errors === 1 ? '' : 's'} and
                        never evaluated — {assertion.lastError}
                      </span>
                    ) : (
                      <>
                        <span>
                          {assertion.checked} run{assertion.checked === 1 ? '' : 's'} checked
                        </span>
                        {assertion.violations > 0 && (
                          <span className="assertion__violations">
                            {assertion.violations} violation
                            {assertion.violations === 1 ? '' : 's'}
                          </span>
                        )}
                        {assertion.errors > 0 && (
                          <span className="assertion__errors">
                            {assertion.errors} threw
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {assertion.lastViolationExecutionId && (
                    // The counterexample is the whole value of a violation.
                    <div className="assertion__counterexample">
                      last matched run{' '}
                      <code>{assertion.lastViolationExecutionId.slice(0, 8)}</code>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {composing ? (
          <form className="assertion-form" onSubmit={pin}>
            <label className="assertion-form__field">
              <span>What must never happen</span>
              <input
                type="text"
                value={name}
                placeholder="A completed run whose charge failed"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="assertion-form__field">
              <span>The shape of that run, in FXL</span>
              <textarea
                rows={2}
                value={predicate}
                placeholder={'status == "completed" and steps.charge.output.status >= 400'}
                onChange={(e) => setPredicate(e.target.value)}
              />
            </label>
            {formError && <p className="assertion-form__error">{formError}</p>}
            <div className="assertion-form__actions">
              <button
                type="button"
                className="assertion-form__cancel"
                onClick={() => {
                  setComposing(false)
                  setFormError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="assertion-form__pin"
                disabled={busy || !name.trim() || !predicate.trim()}
              >
                {busy ? 'Pinning…' : 'Pin it'}
              </button>
            </div>
          </form>
        ) : (
          report && (
            <button className="assertion-add" onClick={() => setComposing(true)}>
              + Pin something that must never happen
            </button>
          )
        )}
      </div>
    </aside>
  )
}
