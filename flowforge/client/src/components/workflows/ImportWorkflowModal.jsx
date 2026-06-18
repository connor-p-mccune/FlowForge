import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'

// Keep in sync with MAX_IMPORT_GRAPH_BYTES in server/src/routes/workflows.js. The
// server is the source of truth; this just lets us reject an oversized file with a
// clear message before uploading it.
const MAX_GRAPH_BYTES = 500 * 1024

function graphByteSize(graphData) {
  return new Blob([JSON.stringify(graphData)]).size
}

// Modal: pick a .json export, validate it client-side, name the workflow, and
// import it. Mirrors TemplateGallery's portal + Escape-to-close pattern.
export default function ImportWorkflowModal({ workspaceId, onClose, onCreated }) {
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [graph, setGraph] = useState(null) // validated { nodes, edges }, or null
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)

  // Close on Escape.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleFile = useCallback((file) => {
    setError(null)
    setGraph(null)
    if (!file) return

    const reader = new FileReader()
    reader.onerror = () => setError('Could not read that file. Please try again.')
    reader.onload = () => {
      let parsed
      try {
        parsed = JSON.parse(reader.result)
      } catch {
        setError('That file isn’t valid JSON. Pick a workflow you exported from FlowForge.')
        return
      }

      const gd = parsed && parsed.graph_data
      if (!gd || typeof gd !== 'object' || !Array.isArray(gd.nodes) || !Array.isArray(gd.edges)) {
        setError('This file is missing workflow data (it needs graph_data with nodes and edges).')
        return
      }

      if (graphByteSize(gd) > MAX_GRAPH_BYTES) {
        setError('This workflow is too large to import (over 500KB).')
        return
      }

      setGraph({ nodes: gd.nodes, edges: gd.edges })
      // Pre-fill the name from the file, falling back to its filename.
      setName((parsed.name || file.name.replace(/\.json$/i, '')).slice(0, 200))
    }
    reader.readAsText(file)
  }, [])

  const handleImport = useCallback(async () => {
    if (!graph || !workspaceId) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Give the imported workflow a name.')
      return
    }
    setImporting(true)
    setError(null)
    try {
      const { workflow } = await apiFetch(`/api/workspaces/${workspaceId}/workflows/import`, {
        method: 'POST',
        body: { name: trimmed, graph_data: graph },
      })
      onCreated?.(workflow)
      onClose()
      navigate(`/workflow/${workflow.id}`)
    } catch (err) {
      setError(err.message)
      setImporting(false)
    }
  }, [graph, workspaceId, name, onCreated, onClose, navigate])

  return createPortal(
    <div
      className="import-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Import workflow"
      onClick={onClose}
    >
      {/* Stop backdrop clicks inside the panel from closing it. */}
      <div className="import-modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="import-modal__header">
          <h2 className="import-modal__title">Import workflow</h2>
          <button className="import-modal__close" title="Close" onClick={onClose}>×</button>
        </header>

        <div className="import-modal__body">
          <label className="import-modal__field-label" htmlFor="import-file">
            Workflow file
          </label>
          <input
            id="import-file"
            className="import-modal__file"
            type="file"
            accept="application/json,.json"
            onChange={(e) => handleFile(e.target.files && e.target.files[0])}
          />

          {graph && (
            <>
              <label className="import-modal__field-label" htmlFor="import-name">
                Name
              </label>
              <input
                id="import-name"
                className="import-modal__input"
                type="text"
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
              <p className="import-modal__preview">
                {`${graph.nodes.length} ${graph.nodes.length === 1 ? 'node' : 'nodes'} · ${graph.edges.length} ${graph.edges.length === 1 ? 'edge' : 'edges'}`}
              </p>
            </>
          )}

          {error && <p className="import-modal__error">{error}</p>}
        </div>

        <footer className="import-modal__actions">
          <button className="import-modal__btn" onClick={onClose}>Cancel</button>
          <button
            className="import-modal__btn import-modal__btn--primary"
            onClick={handleImport}
            disabled={!graph || importing}
          >
            {importing ? 'Importing…' : 'Import'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
