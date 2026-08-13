import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiFetch } from '../../services/api'

// Breakpoints, and the pause itself.
//
// The panel has two states and they are the two halves of using a debugger:
// **arming** (which nodes should stop the run, then start it) and **stopped**
// (here is what this node received, here is what it is about to do, change it
// or let it go).
//
// The stopped state shows *resolved* values — `{{trigger.orderId}}` already
// substituted — because a debugger that showed the template would be showing
// the thing you can already read on the canvas. What is worth stopping for is
// the value the template produced, which exists nowhere else.
//
// The override editors are plain JSON textareas rather than a form. A node's
// config is arbitrarily shaped and the point of an override is to try something
// the UI has no field for; a generated form would be the one place you cannot
// type what you actually want to test.

const ACTIONS = [
  { value: 'continue', label: '▶ Continue', title: 'Run to the next breakpoint' },
  { value: 'step', label: '⤵ Step', title: 'Stop again at the very next node' },
  { value: 'abort', label: '■ Abort', title: 'Cancel the run from here' },
]

// Nodes that never execute, and so can never be stopped at.
const NOT_RUNNABLE = new Set(['note'])

export default function DebuggerPanel({
  nodes,
  executionId,
  activeBreak,
  onClose,
  onSelectNode,
  onStartDebugRun,
  onResumed,
}) {
  const [breakpoints, setBreakpoints] = useState(() => new Set())
  const [stepFromStart, setStepFromStart] = useState(false)
  const [configOverride, setConfigOverride] = useState('')
  const [inputOverride, setInputOverride] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const runnable = useMemo(() => nodes.filter((n) => !NOT_RUNNABLE.has(n.type)), [nodes])

  // Keyed on the break id, not the object: the run stopping somewhere new
  // clears the editors, while a re-render of the same pause leaves whatever
  // somebody is halfway through typing alone.
  const breakId = activeBreak?.breakId
  useEffect(() => {
    if (!breakId) return
    setConfigOverride('')
    setInputOverride('')
    setError(null)
  }, [breakId])

  const toggle = useCallback((nodeId) => {
    setBreakpoints((prev) => {
      const next = new Set(prev)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  const resume = useCallback(
    async (action) => {
      setBusy(true)
      try {
        setError(null)
        let override = null
        // Parsed here rather than sent as text: an override that failed to
        // parse server-side would resume the run with the *original* value and
        // look like the change silently did nothing.
        const parse = (raw, what) => {
          if (!raw.trim()) return null
          try {
            const value = JSON.parse(raw)
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
              throw new Error('must be a JSON object')
            }
            return value
          } catch (err) {
            throw new Error(`The ${what} override ${err.message}`)
          }
        }
        const config = parse(configOverride, 'config')
        const input = parse(inputOverride, 'input')
        if (config || input) override = { ...(config ? { config } : {}), ...(input ? { input } : {}) }

        await apiFetch(`/api/executions/${executionId}/breaks/${activeBreak.breakId}/resume`, {
          method: 'POST',
          body: { action, ...(override ? { override } : {}) },
        })
        onResumed?.()
      } catch (err) {
        setError(err.message)
      } finally {
        setBusy(false)
      }
    },
    [executionId, activeBreak, configOverride, inputOverride, onResumed]
  )

  return (
    <aside className="issues-panel debugger-panel" aria-label="Debugger">
      <div className="issues-panel__header">
        <span className="issues-panel__title">🐞 Debugger</span>
        {activeBreak && <span className="debugger__pill">paused</span>}
        <button className="issues-panel__close" title="Close" onClick={onClose}>×</button>
      </div>

      <div className="issues-panel__body">
        {error && <p className="issues-panel__error">{error}</p>}

        {activeBreak ? (
          <>
            <h3 className="lineage-section">Stopped before</h3>
            <p className="debugger__node">
              <button className="lineage-link" onClick={() => onSelectNode(activeBreak.nodeId)}>
                {activeBreak.nodeLabel || activeBreak.nodeId}
              </button>
              <span className="lineage-chain__where">has not run yet</span>
            </p>

            <Inspect title="Input it received" value={activeBreak.input} />
            <Inspect title="Config it will run with" value={activeBreak.config} />

            <h3 className="lineage-section">Change it before it runs</h3>
            <label className="debugger__label" htmlFor="debug-config-override">
              Config patch (JSON — merged over the resolved config)
            </label>
            <textarea
              id="debug-config-override"
              className="debugger__editor"
              rows={3}
              placeholder='{ "url": "https://staging.example.com/orders" }'
              value={configOverride}
              onChange={(e) => setConfigOverride(e.target.value)}
            />
            <label className="debugger__label" htmlFor="debug-input-override">
              Input patch (JSON)
            </label>
            <textarea
              id="debug-input-override"
              className="debugger__editor"
              rows={3}
              placeholder='{ "amount": 5000 }'
              value={inputOverride}
              onChange={(e) => setInputOverride(e.target.value)}
            />

            <div className="debugger__actions">
              {ACTIONS.map((action) => (
                <button
                  key={action.value}
                  className={`tests-btn${action.value === 'continue' ? ' tests-btn--primary' : ''}${
                    action.value === 'abort' ? ' tests-btn--danger' : ''
                  }`}
                  title={action.title}
                  disabled={busy}
                  onClick={() => resume(action.value)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="issues-panel__hint">
              Pick where the run should stop. A breakpoint belongs to the run you
              start from here — there is nowhere to leave one on the workflow, so a
              schedule or a webhook can never hit it.
            </p>

            <ul className="debugger__list">
              {runnable.map((node) => (
                <li key={node.id}>
                  <label className="debugger__breakpoint">
                    <input
                      type="checkbox"
                      checked={breakpoints.has(node.id)}
                      onChange={() => toggle(node.id)}
                    />
                    <span className="debugger__dot" aria-hidden="true" />
                    <span>{node.data?.label || node.id}</span>
                    <span className="lineage-chain__where">{node.type}</span>
                  </label>
                </li>
              ))}
            </ul>

            <label className="debugger__breakpoint debugger__breakpoint--step">
              <input
                type="checkbox"
                checked={stepFromStart}
                onChange={(e) => setStepFromStart(e.target.checked)}
              />
              <span>Stop at every node</span>
            </label>

            <button
              className="tests-btn tests-btn--primary debugger__start"
              disabled={breakpoints.size === 0 && !stepFromStart}
              onClick={() => onStartDebugRun({ breakpoints: [...breakpoints], stepFromStart })}
            >
              🐞 Run with breakpoints
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

function Inspect({ title, value }) {
  return (
    <>
      <h3 className="lineage-section">{title}</h3>
      <pre className="debugger__value">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </>
  )
}
