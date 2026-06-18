import { useCallback, useEffect, useState } from 'react'
import ReactFlow, { Background, ReactFlowProvider } from 'reactflow'
import { apiFetch } from '../../services/api'
import { nodeTypes } from './nodeTypes'

function formatWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : ''
}

// Read-only mini canvas for a past version's graph. Wrapped in its own
// ReactFlowProvider so its store is isolated from the live editor's store
// (two <ReactFlow> instances must not share one provider). Fully non-interactive.
function GraphPreview({ nodes, edges }) {
  return (
    <ReactFlowProvider>
      <div className="version-preview__canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  )
}

// Slide-out drawer listing every deployed version of a workflow. Each entry can
// expand to a read-only preview of that version's graph and offers a Restore
// action (guarded by a confirmation dialog). On a successful restore the parent
// reloads the canvas via onRestored.
export default function HistoryPanel({ workflowId, open, reloadSignal, onClose, onRestored }) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [expandedId, setExpandedId] = useState(null) // version currently previewed
  const [preview, setPreview] = useState(null) // { nodes, edges } for expandedId
  const [previewLoading, setPreviewLoading] = useState(false)

  const [confirmId, setConfirmId] = useState(null) // version pending restore confirm
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { versions: list } = await apiFetch(`/api/workflows/${workflowId}/versions`)
      setVersions(list)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  useEffect(() => {
    if (!open) {
      // Reset transient UI so the drawer reopens clean.
      setExpandedId(null)
      setPreview(null)
      setConfirmId(null)
      return
    }
    load()
  }, [open, load, reloadSignal])

  const handleTogglePreview = useCallback(
    async (version) => {
      if (expandedId === version.id) {
        setExpandedId(null)
        setPreview(null)
        return
      }
      setExpandedId(version.id)
      setPreview(null)
      setPreviewLoading(true)
      try {
        const { graph_data } = await apiFetch(
          `/api/workflows/${workflowId}/versions/${version.id}`
        )
        setPreview({ nodes: graph_data.nodes || [], edges: graph_data.edges || [] })
      } catch (err) {
        setError(err.message)
        setExpandedId(null)
      } finally {
        setPreviewLoading(false)
      }
    },
    [expandedId, workflowId]
  )

  const confirmVersion = versions.find((v) => v.id === confirmId) || null

  async function handleRestore() {
    if (!confirmId) return
    setRestoring(true)
    setError(null)
    try {
      const { workflow } = await apiFetch(
        `/api/workflows/${workflowId}/versions/${confirmId}/restore`,
        { method: 'POST' }
      )
      setConfirmId(null)
      onRestored(workflow)
    } catch (err) {
      setError(err.message)
    } finally {
      setRestoring(false)
    }
  }

  if (!open) return null

  return (
    <>
      <aside className="history-panel">
        <div className="history-panel__header">
          <span className="history-panel__title">🕘 Version history</span>
          <button className="history-panel__close" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="history-panel__body">
          <p className="history-panel__hint">
            Each deploy saves a snapshot. Restoring rolls the canvas back to a version —
            your current state is saved as a new version first.
          </p>
          {error && <p className="history-panel__error">{error}</p>}
          {loading ? (
            <p className="history-panel__hint">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="history-panel__hint">No versions yet. Click Deploy to save one.</p>
          ) : (
            <ul className="version-list">
              {versions.map((v) => (
                <li className="version-item" key={v.id}>
                  <div className="version-item__row">
                    <div className="version-item__meta">
                      <span className="version-item__num">Version {v.version}</span>
                      <span className="version-item__when">{formatWhen(v.created_at)}</span>
                      <span className="version-item__who">by {v.created_by_name || 'Unknown'}</span>
                    </div>
                    <div className="version-item__actions">
                      <button
                        className="version-item__preview-btn"
                        onClick={() => handleTogglePreview(v)}
                      >
                        {expandedId === v.id ? 'Hide' : 'Preview'}
                      </button>
                      <button
                        className="version-item__restore"
                        onClick={() => setConfirmId(v.id)}
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                  {expandedId === v.id && (
                    <div className="version-preview">
                      {previewLoading || !preview ? (
                        <p className="history-panel__hint">Loading preview…</p>
                      ) : preview.nodes.length === 0 ? (
                        <p className="history-panel__hint">This version has no nodes.</p>
                      ) : (
                        <GraphPreview nodes={preview.nodes} edges={preview.edges} />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {confirmVersion && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-dialog">
            <p className="confirm-dialog__message">
              This will replace your current workflow with version {confirmVersion.version}. Your
              current state will be saved as a new version first.
            </p>
            <div className="confirm-dialog__actions">
              <button
                className="confirm-dialog__cancel"
                onClick={() => setConfirmId(null)}
                disabled={restoring}
              >
                Cancel
              </button>
              <button
                className="confirm-dialog__confirm"
                onClick={handleRestore}
                disabled={restoring}
              >
                {restoring ? 'Restoring…' : `Restore version ${confirmVersion.version}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
