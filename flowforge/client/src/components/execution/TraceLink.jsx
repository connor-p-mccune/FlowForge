import { useState } from 'react'
import { apiFetchText } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// The run's trace id, with the two things anyone actually wants to do with it.
//
// Copying the id is the common case by a wide margin: you paste it into
// whatever tracing backend the rest of the stack already uses and see the spans
// this run's HTTP nodes caused, alongside spans FlowForge never saw. Downloading
// the OTLP document is the other case — pushing a single run into a collector
// to look at it without wiring up an exporter first.
//
// Rendered only when the run actually carries a trace, so runs recorded before
// tracing existed show nothing rather than an id that means nothing.
export default function TraceLink({ executionId, traceId }) {
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  if (!traceId) return null

  async function copyTraceId() {
    try {
      await navigator.clipboard.writeText(traceId)
      toast.success('Trace ID copied')
    } catch {
      // Clipboard access is permission-gated and refused outright in some
      // contexts; the id is on screen either way, so this is a nudge rather
      // than a failure.
      toast.error('Couldn’t copy — select the ID above instead')
    }
  }

  async function downloadTrace() {
    setBusy(true)
    try {
      const body = await apiFetchText(`/api/executions/${executionId}/trace`)
      const blob = new Blob([body], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `trace-${traceId.slice(0, 12)}.otlp.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="trace-link">
      <span className="trace-link__label">Trace</span>
      <code className="trace-link__id" title={traceId}>
        {traceId.slice(0, 16)}…
      </code>
      <button className="trace-link__btn" onClick={copyTraceId}>
        Copy ID
      </button>
      <button className="trace-link__btn" onClick={downloadTrace} disabled={busy}>
        {busy ? 'Exporting…' : 'OTLP'}
      </button>
    </div>
  )
}
