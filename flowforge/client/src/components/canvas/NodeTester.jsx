import { useState } from 'react'
import { apiFetch } from '../../services/api'

// Node types the bench can't run in isolation — they only make sense inside a
// full engine run (mirrors BENCH_UNSUPPORTED on the server). The Test section
// is hidden for these.
const UNSUPPORTED = new Set(['approval', 'sub-workflow', 'for-each'])

// A compact "run this one node" bench, embedded in the node config panel. It
// POSTs the node exactly as the canvas currently has it (unsaved edits
// included) to /api/workflows/:id/test-node, dry-run by default so side-
// effecting nodes report what they'd send rather than firing. An optional
// sample-input JSON stands in for upstream output.
export default function NodeTester({ workflowId, node }) {
  const [open, setOpen] = useState(false)
  const [inputText, setInputText] = useState('')
  const [live, setLive] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null) // { status, output|error, dryRun, durationMs }
  const [error, setError] = useState(null) // request-level failure (not a node failure)

  // The panel is shared by tests that don't pass a workflowId; without one
  // there's nothing to POST to, so render nothing.
  if (!workflowId || UNSUPPORTED.has(node.type)) return null

  async function handleRun() {
    let input
    if (inputText.trim()) {
      try {
        input = JSON.parse(inputText)
      } catch {
        setError('Sample input must be valid JSON')
        return
      }
    }
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch(`/api/workflows/${workflowId}/test-node`, {
        method: 'POST',
        body: { node, input, live },
      })
      setResult(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="node-tester">
      <button
        type="button"
        className="node-tester__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'} Test this node
      </button>
      {open && (
        <div className="node-tester__body">
          <label className="node-tester__field">
            <span>Sample input (JSON, optional)</span>
            <textarea
              className="node-tester__input"
              rows={3}
              placeholder='{"name": "Ada"}'
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
          </label>
          <label className="node-tester__live">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <span>Fire real actions (off = dry run)</span>
          </label>
          <button
            type="button"
            className="node-tester__run"
            onClick={handleRun}
            disabled={running}
          >
            {running ? 'Running…' : '▶ Run node'}
          </button>
          {error && <p className="node-tester__error">{error}</p>}
          {result && (
            <div className={`node-tester__result node-tester__result--${result.status}`} role="status">
              <div className="node-tester__result-head">
                <span className={`status-badge status-badge--${result.status}`}>
                  {result.status}
                </span>
                {result.dryRun && <span className="node-tester__dry">dry run</span>}
                <span className="node-tester__duration">{result.durationMs}ms</span>
              </div>
              <pre className="node-tester__output">
                {result.status === 'failed'
                  ? result.error
                  : JSON.stringify(result.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
