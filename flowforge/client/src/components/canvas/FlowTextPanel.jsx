import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, apiFetchText } from '../../services/api'

// The workflow as text (docs/DSL.md), editable.
//
// The canvas is for drawing; this is for surgery. Renaming twelve nodes,
// repointing five HTTP nodes at a new host, or reordering a switch's cases are
// each one find-and-replace here and twelve dialogs there — and the second is
// why people give up and edit the database.
//
// Applying goes to the server, which parses and writes, and the canvas then
// reloads the result. Same shape as a merge or a version restore, and for the
// same reason: the collaboration layer sees one external change rather than a
// storm of synthetic edits, and there is exactly one parser.
//
// A syntax error arrives with a line, a column and the offending line — so the
// panel can put the cursor on it rather than describe where it is.

function ErrorFrame({ error }) {
  if (!error) return null
  return (
    <div className="flowtext__error" role="alert">
      <div className="flowtext__error-message">
        {error.line ? `Line ${error.line}: ` : ''}
        {error.message}
      </div>
      {error.frame && <pre className="flowtext__error-frame">{error.frame}</pre>}
    </div>
  )
}

export default function FlowTextPanel({ workflowId, open, onClose, onApplied }) {
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const areaRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await apiFetchText(`/api/workflows/${workflowId}/export?format=flow`)
      setText(body)
      setOriginal(body)
    } catch (err) {
      setError({ message: err.message })
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // Put the caret where the parser stopped. A position reported and not used is
  // a position the reader has to count to.
  function focusError(position) {
    const area = areaRef.current
    if (!area || !position?.line) return
    const lines = text.split('\n')
    let offset = 0
    for (let i = 0; i < position.line - 1 && i < lines.length; i++) offset += lines[i].length + 1
    offset += Math.max(0, (position.column || 1) - 1)
    area.focus()
    area.setSelectionRange(offset, offset)
  }

  async function handleApply() {
    setSaving(true)
    setError(null)
    try {
      const { workflow } = await apiFetch(`/api/workflows/${workflowId}/flow`, {
        method: 'PUT',
        body: { flow: text },
      })
      setOriginal(text)
      onApplied?.(workflow)
    } catch (err) {
      // The thrown Error carries the response body, so the position the parser
      // stopped at survives the round trip and the caret can be put on it.
      const { line, column, frame } = err.body || {}
      setError({ message: err.message, line, column, frame })
      focusError({ line, column })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const dirty = text !== original

  return (
    <aside className="webhook-panel flowtext-panel" aria-label="Workflow as text">
      <div className="webhook-panel__header">
        <span className="webhook-panel__title">Text</span>
        <button className="webhook-panel__close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="webhook-panel__body">
        <p className="webhook-panel__hint">
          The whole workflow as <code>.flow</code> — its name, description,
          guarantees, nodes and connections. Edit and apply, or copy it into a
          pull request. Renaming a dozen nodes is one find-and-replace here.
        </p>
        {loading ? (
          <p className="webhook-panel__hint">Loading…</p>
        ) : (
          <>
            <textarea
              ref={areaRef}
              className="flowtext__editor"
              spellCheck={false}
              value={text}
              aria-label="Workflow source"
              onChange={(e) => setText(e.target.value)}
            />
            <ErrorFrame error={error} />
            <div className="flowtext__actions">
              <button
                className="webhook-panel__btn"
                disabled={!dirty || saving}
                onClick={handleApply}
              >
                {saving ? 'Applying…' : 'Apply'}
              </button>
              <button className="webhook-panel__btn" disabled={!dirty || saving} onClick={() => setText(original)}>
                Revert
              </button>
              <button className="webhook-panel__btn" onClick={load} disabled={saving}>
                Reload
              </button>
            </div>
            {dirty && !error && (
              <p className="webhook-panel__hint">
                Unapplied edits. Applying replaces the workflow with what is in this
                box — the version history is the way back.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
