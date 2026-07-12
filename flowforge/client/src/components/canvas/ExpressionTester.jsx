import { useState } from 'react'
import { apiFetch } from '../../services/api'

// A compact FXL playground embedded under an expression field. Evaluate the
// field's current expression against a sample scope (JSON you edit) and see the
// result — or the syntax/runtime error — inline, without running the whole
// graph. It calls POST /api/expressions/evaluate, which runs the same evaluator
// and safety bounds the engine uses, so a green result here is what the node
// will compute.

function ResultView({ state }) {
  if (state.requestError) {
    return <p className="expr-tester__error">{state.requestError}</p>
  }
  if (state.ok === false) {
    return (
      <p className="expr-tester__error">
        <strong>Error:</strong> {state.error}
      </p>
    )
  }
  return (
    <div className="expr-tester__result">
      <span className="expr-tester__type">{state.resultType}</span>
      <pre className="expr-tester__value">{JSON.stringify(state.result, null, 2)}</pre>
    </div>
  )
}

export default function ExpressionTester({ expression, sampleScope }) {
  const [open, setOpen] = useState(false)
  const [scopeText, setScopeText] = useState(sampleScope || '{\n  \n}')
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setState(null)
    let scope
    try {
      scope = scopeText.trim() ? JSON.parse(scopeText) : {}
    } catch {
      setState({ requestError: 'Sample data is not valid JSON.' })
      setBusy(false)
      return
    }
    try {
      const res = await apiFetch('/api/expressions/evaluate', {
        method: 'POST',
        body: { expression, scope },
      })
      setState(res)
    } catch (err) {
      setState({ requestError: err.message })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="expr-tester__toggle" onClick={() => setOpen(true)}>
        ▸ Try this expression
      </button>
    )
  }

  return (
    <div className="expr-tester">
      <div className="expr-tester__header">
        <span>Try this expression</span>
        <button
          type="button"
          className="expr-tester__close"
          title="Close"
          onClick={() => setOpen(false)}
        >
          ×
        </button>
      </div>
      <label className="config-panel__field">
        <span>Sample data (JSON)</span>
        <textarea
          className="config-panel__code"
          rows={4}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="expr-tester__run"
        onClick={run}
        disabled={busy || !expression || !expression.trim()}
      >
        {busy ? 'Evaluating…' : 'Evaluate'}
      </button>
      {!expression?.trim() && (
        <p className="config-panel__hint">Write an expression above, then evaluate it here.</p>
      )}
      {state && <ResultView state={state} />}
    </div>
  )
}
