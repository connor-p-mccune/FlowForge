import { useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// Workflow test scenarios panel. A scenario is a named trigger payload plus a
// list of FXL assertions over the resulting run's output; running it drives the
// workflow in dry-run mode and reports which assertions held. This panel is the
// authoring + running surface for GET/POST /api/workflows/:id/tests (the same
// suite the CLI's `flowforge test` and the public CI-gate endpoint run).
//
// Assertions read from a scope of { output, steps, status } — e.g.
// `output.total > 0`, `steps["http-1"].status == 200`, `status == "completed"`.

const BLANK_DRAFT = { name: '', inputText: '{}', assertions: [{ expression: '', description: '' }] }

// A stored scenario → the editor's draft shape (JSON pretty-printed for editing).
function toDraft(test) {
  return {
    name: test.name,
    inputText: JSON.stringify(test.input ?? {}, null, 2),
    assertions:
      test.assertions.length > 0
        ? test.assertions.map((a) => ({ expression: a.expression, description: a.description || '' }))
        : [{ expression: '', description: '' }],
  }
}

// Validate + serialize a draft into the API body, or return { error }.
function draftToBody(draft) {
  const name = draft.name.trim()
  if (!name) return { error: 'Give the scenario a name.' }
  let input
  try {
    input = draft.inputText.trim() ? JSON.parse(draft.inputText) : {}
  } catch {
    return { error: 'Trigger input is not valid JSON.' }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Trigger input must be a JSON object.' }
  }
  const assertions = draft.assertions
    .filter((a) => a.expression.trim())
    .map((a) => ({ expression: a.expression.trim(), description: a.description.trim() || undefined }))
  if (assertions.length === 0) return { error: 'Add at least one assertion.' }
  return { body: { name, input, assertions } }
}

// The editor for a new or existing scenario.
function ScenarioEditor({ initial, onSave, onCancel, saving }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState(null)

  const setAssertion = (i, field, value) =>
    setDraft((d) => ({
      ...d,
      assertions: d.assertions.map((a, j) => (j === i ? { ...a, [field]: value } : a)),
    }))
  const addAssertion = () =>
    setDraft((d) => ({ ...d, assertions: [...d.assertions, { expression: '', description: '' }] }))
  const removeAssertion = (i) =>
    setDraft((d) => ({ ...d, assertions: d.assertions.filter((_, j) => j !== i) }))

  const submit = () => {
    const { body, error: err } = draftToBody(draft)
    if (err) return setError(err)
    setError(null)
    onSave(body)
  }

  return (
    <div className="tests-editor">
      <label className="config-panel__field">
        <span>Scenario name</span>
        <input
          value={draft.name}
          placeholder="happy path"
          aria-label="Scenario name"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />
      </label>
      <label className="config-panel__field">
        <span>Trigger input (JSON)</span>
        <textarea
          className="config-panel__code"
          rows={3}
          value={draft.inputText}
          aria-label="Trigger input"
          onChange={(e) => setDraft((d) => ({ ...d, inputText: e.target.value }))}
        />
      </label>
      <span className="config-panel__field-label">Assertions (FXL over output / steps / status)</span>
      {draft.assertions.map((a, i) => (
        <div key={i} className="tests-assertion-edit">
          <input
            className="tests-assertion-edit__expr"
            value={a.expression}
            placeholder={'output.total > 0'}
            aria-label={`Assertion ${i + 1} expression`}
            onChange={(e) => setAssertion(i, 'expression', e.target.value)}
          />
          <input
            className="tests-assertion-edit__desc"
            value={a.description}
            placeholder="what it checks (optional)"
            aria-label={`Assertion ${i + 1} description`}
            onChange={(e) => setAssertion(i, 'description', e.target.value)}
          />
          <button
            type="button"
            className="switch-case__remove"
            aria-label={`Remove assertion ${i + 1}`}
            onClick={() => removeAssertion(i)}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="switch-case__add" onClick={addAssertion}>
        + Add assertion
      </button>
      {error && <p className="webhook-panel__error">{error}</p>}
      <div className="tests-editor__actions">
        <button type="button" className="tests-btn tests-btn--primary" disabled={saving} onClick={submit}>
          {saving ? 'Saving…' : 'Save scenario'}
        </button>
        <button type="button" className="tests-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// One scenario row: name, its last result badge, run/edit/delete, and — when a
// result is present — the per-assertion pass/fail breakdown.
function ScenarioRow({ test, result, busy, onRun, onEdit, onDelete }) {
  const badge =
    result == null
      ? null
      : result.passed
        ? <span className="tests-badge tests-badge--pass">passed</span>
        : <span className="tests-badge tests-badge--fail">failed</span>

  return (
    <div className="tests-scenario">
      <div className="tests-scenario__head">
        <span className="tests-scenario__name">{test.name}</span>
        {badge}
        <span className="tests-scenario__spacer" />
        <button type="button" className="tests-btn" disabled={busy} onClick={onRun}>
          {busy ? '…' : 'Run'}
        </button>
        <button type="button" className="tests-btn" onClick={onEdit}>Edit</button>
        <button type="button" className="tests-btn tests-btn--danger" onClick={onDelete}>Delete</button>
      </div>
      {result && result.runStatus && result.runStatus !== 'completed' && (
        <p className="tests-scenario__runstatus">run {result.runStatus}</p>
      )}
      {result && (
        <ul className="tests-assertions">
          {result.assertions.map((a, i) => (
            <li key={i} className={`tests-assertion${a.passed ? '' : ' tests-assertion--fail'}`}>
              <span className="tests-assertion__mark">{a.passed ? '✓' : '✗'}</span>
              <code className="tests-assertion__expr">{a.expression}</code>
              {a.description && <span className="tests-assertion__desc">{a.description}</span>}
              {a.error && <span className="tests-assertion__error">{a.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function TestsPanel({ workflowId, open, onClose }) {
  const [tests, setTests] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [results, setResults] = useState({}) // testId -> result
  const [busy, setBusy] = useState({}) // testId | '__all__' -> bool
  const [editing, setEditing] = useState(null) // testId | '__new__' | null
  const [saving, setSaving] = useState(false)

  function reload() {
    setError(null)
    apiFetch(`/api/workflows/${workflowId}/tests`)
      .then((d) => setTests(d.tests))
      .catch((e) => setError(e.message))
  }

  useEffect(() => {
    if (!open) return
    setTests(null)
    setResults({})
    setEditing(null)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId])

  if (!open) return null

  const setBusyFor = (key, value) => setBusy((b) => ({ ...b, [key]: value }))

  async function runOne(testId) {
    setBusyFor(testId, true)
    try {
      const { result } = await apiFetch(`/api/workflows/${workflowId}/tests/${testId}/run`, { method: 'POST' })
      setResults((r) => ({ ...r, [testId]: result }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyFor(testId, false)
    }
  }

  async function runAll() {
    setBusyFor('__all__', true)
    try {
      const summary = await apiFetch(`/api/workflows/${workflowId}/tests/run`, { method: 'POST' })
      const byId = {}
      for (const s of summary.scenarios) byId[s.id] = s
      setResults(byId)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyFor('__all__', false)
    }
  }

  async function save(body) {
    setSaving(true)
    try {
      if (editing === '__new__') {
        await apiFetch(`/api/workflows/${workflowId}/tests`, { method: 'POST', body })
      } else {
        await apiFetch(`/api/workflows/${workflowId}/tests/${editing}`, { method: 'PUT', body })
      }
      setEditing(null)
      reload()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(testId) {
    try {
      await apiFetch(`/api/workflows/${workflowId}/tests/${testId}`, { method: 'DELETE' })
      setResults((r) => {
        const next = { ...r }
        delete next[testId]
        return next
      })
      reload()
    } catch (e) {
      setError(e.message)
    }
  }

  const passed = tests ? tests.filter((t) => results[t.id]?.passed).length : 0
  const ran = tests ? tests.filter((t) => results[t.id]).length : 0

  return (
    <aside className="webhook-panel tests-panel" aria-label="Test scenarios">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Tests</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="webhook-panel__body">
        {error && <p className="webhook-panel__error">{error}</p>}
        {!tests && !error && <p className="webhook-panel__hint">Loading…</p>}

        {tests && (
          <>
            <div className="tests-panel__toolbar">
              <button
                type="button"
                className="tests-btn tests-btn--primary"
                disabled={busy.__all__ || tests.length === 0}
                onClick={runAll}
              >
                {busy.__all__ ? 'Running…' : 'Run all'}
              </button>
              {ran > 0 && (
                <span className={`tests-summary${passed === ran ? ' tests-summary--pass' : ' tests-summary--fail'}`}>
                  {passed}/{ran} passed
                </span>
              )}
            </div>

            {tests.length === 0 && !editing && (
              <p className="webhook-panel__hint">
                No scenarios yet. A scenario runs the workflow with a sample input and
                checks the result — regression tests for your workflow.
              </p>
            )}

            {tests.map((t) =>
              editing === t.id ? (
                <ScenarioEditor
                  key={t.id}
                  initial={toDraft(t)}
                  saving={saving}
                  onSave={save}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <ScenarioRow
                  key={t.id}
                  test={t}
                  result={results[t.id]}
                  busy={busy[t.id]}
                  onRun={() => runOne(t.id)}
                  onEdit={() => setEditing(t.id)}
                  onDelete={() => remove(t.id)}
                />
              )
            )}

            {editing === '__new__' ? (
              <ScenarioEditor
                initial={BLANK_DRAFT}
                saving={saving}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <button
                type="button"
                className="tests-btn tests-btn--add"
                onClick={() => setEditing('__new__')}
              >
                + Add scenario
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
