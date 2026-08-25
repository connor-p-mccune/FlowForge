import { useState } from 'react'
import { apiFetch } from '../../services/api'

// Asking a question of run history from the panel that lists it.
//
// The list beside this is the fifty most recent runs, which is the right
// default for a history view and the wrong one for a question — the run
// somebody is looking for is usually old precisely *because* it is the one they
// remember. So a match here replaces the list rather than filtering it: the
// predicate decides what comes back, not recency.
//
// The predicate is FXL, the same language a condition node takes, so anybody
// who has written a condition on the canvas can already write one here.

const EXAMPLES = [
  'status == "failed"',
  'durationMs > 60000',
  'waitMs > 30000',
]

// A caret under the character the parser stopped at. Without it somebody counts
// brackets, which is the whole reason the position comes back over the wire.
function Caret({ source, position }) {
  if (position == null || position < 0) return null
  return (
    <pre className="run-query__caret">
      {source}
      {'\n'}
      {' '.repeat(Math.min(position, source.length))}^
    </pre>
  )
}

export default function RunQueryBar({ workflowId, onResult, active }) {
  const [where, setWhere] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e?.preventDefault()
    const predicate = where.trim()
    if (!predicate) return
    setBusy(true)
    setError(null)
    try {
      const result = await apiFetch(`/api/workflows/${workflowId}/query`, {
        method: 'POST',
        body: { where: predicate, limit: 200 },
      })
      onResult(result)
    } catch (err) {
      // A predicate that does not parse is the author's mistake, not a failure
      // of the panel — so it renders here rather than as a toast that scrolls
      // away before they can compare it against what they typed.
      setError({ message: err.body?.error || err.message, position: err.body?.position ?? null })
      onResult(null)
    } finally {
      setBusy(false)
    }
  }

  function clear() {
    setWhere('')
    setError(null)
    onResult(null)
  }

  return (
    <form className="run-query" onSubmit={submit}>
      <div className="run-query__row">
        <input
          className="run-query__input"
          type="text"
          value={where}
          placeholder='Ask in FXL — status == "failed" and steps.charge.output.status >= 500'
          aria-label="Filter runs with an FXL predicate"
          onChange={(e) => setWhere(e.target.value)}
        />
        <button className="run-query__go" type="submit" disabled={busy || !where.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </button>
        {active && (
          <button className="run-query__clear" type="button" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {error && (
        <div className="run-query__error" role="alert">
          <span className="run-query__error-message">{error.message}</span>
          <Caret source={where} position={error.position} />
        </div>
      )}

      {!active && !error && (
        <div className="run-query__examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              className="run-query__example"
              onClick={() => setWhere(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}
