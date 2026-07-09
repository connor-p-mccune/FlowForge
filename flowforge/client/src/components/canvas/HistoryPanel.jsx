import { useCallback, useEffect, useState } from 'react'
import ReactFlow, { Background, ReactFlowProvider } from 'reactflow'
import { apiFetch } from '../../services/api'
import { nodeTypes } from './nodeTypes'
import { diffGraphs, describeEdge, nodeLabel } from '../../utils/graphDiff'

function formatWhen(iso) {
  return iso ? new Date(iso).toLocaleString() : ''
}

// What changed on the live canvas since `base` (a stored version's graph).
// Read top-down: added = on the canvas but not in the version, removed = in
// the version but gone from the canvas.
function VersionDiff({ base, current }) {
  const diff = diffGraphs(base, current)
  if (diff.identical) {
    return (
      <p className="history-panel__hint">The current canvas matches this version exactly.</p>
    )
  }

  const chips = [
    diff.addedNodes.length && `+${diff.addedNodes.length} node${diff.addedNodes.length > 1 ? 's' : ''}`,
    diff.removedNodes.length && `−${diff.removedNodes.length} node${diff.removedNodes.length > 1 ? 's' : ''}`,
    diff.changedNodes.length && `~${diff.changedNodes.length} changed`,
    diff.addedEdges.length && `+${diff.addedEdges.length} connection${diff.addedEdges.length > 1 ? 's' : ''}`,
    diff.removedEdges.length && `−${diff.removedEdges.length} connection${diff.removedEdges.length > 1 ? 's' : ''}`,
  ].filter(Boolean)

  return (
    <div className="version-diff">
      <p className="version-diff__caption">Changes on the canvas since this version:</p>
      <div className="version-diff__chips">
        {chips.map((chip) => (
          <span className="version-diff__chip" key={chip}>{chip}</span>
        ))}
      </div>
      <ul className="version-diff__list">
        {diff.addedNodes.map((n) => (
          <li className="version-diff__item version-diff__item--added" key={`an-${n.id}`}>
            + {nodeLabel(n)}
          </li>
        ))}
        {diff.removedNodes.map((n) => (
          <li className="version-diff__item version-diff__item--removed" key={`rn-${n.id}`}>
            − {nodeLabel(n)}
          </li>
        ))}
        {diff.changedNodes.map(({ node, changes }) => (
          <li className="version-diff__item version-diff__item--changed" key={`cn-${node.id}`}>
            ~ {nodeLabel(node)}
            <span className="version-diff__fields"> ({changes.join(', ')})</span>
          </li>
        ))}
        {diff.addedEdges.map((e) => (
          <li className="version-diff__item version-diff__item--added" key={`ae-${e.source}-${e.target}-${e.sourceHandle}`}>
            + {describeEdge(e, base, current)}
          </li>
        ))}
        {diff.removedEdges.map((e) => (
          <li className="version-diff__item version-diff__item--removed" key={`re-${e.source}-${e.target}-${e.sourceHandle}`}>
            − {describeEdge(e, base, current)}
          </li>
        ))}
      </ul>
    </div>
  )
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
// expand to a read-only preview of that version's graph or a diff against the
// live canvas, and offers a Restore action (guarded by a confirmation dialog).
// On a successful restore the parent reloads the canvas via onRestored.
export default function HistoryPanel({
  workflowId,
  open,
  reloadSignal,
  onClose,
  onRestored,
  currentNodes,
  currentEdges,
}) {
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const [expandedId, setExpandedId] = useState(null) // version currently expanded
  const [expandedMode, setExpandedMode] = useState('preview') // 'preview' | 'diff'
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
      setExpandedMode('preview')
      setPreview(null)
      setConfirmId(null)
      return
    }
    load()
  }, [open, load, reloadSignal])

  // Expand a version as a graph preview or as a diff against the live canvas.
  // Switching modes on an already-expanded version reuses the fetched graph.
  const handleToggleExpand = useCallback(
    async (version, mode) => {
      if (expandedId === version.id) {
        if (expandedMode === mode) {
          setExpandedId(null)
          setPreview(null)
          return
        }
        setExpandedMode(mode)
        return
      }
      setExpandedId(version.id)
      setExpandedMode(mode)
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
    [expandedId, expandedMode, workflowId]
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
                        onClick={() => handleToggleExpand(v, 'preview')}
                      >
                        {expandedId === v.id && expandedMode === 'preview' ? 'Hide' : 'Preview'}
                      </button>
                      <button
                        className="version-item__preview-btn"
                        title="Compare this version with the current canvas"
                        onClick={() => handleToggleExpand(v, 'diff')}
                      >
                        {expandedId === v.id && expandedMode === 'diff' ? 'Hide' : 'Diff'}
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
                        <p className="history-panel__hint">Loading…</p>
                      ) : expandedMode === 'diff' ? (
                        <VersionDiff
                          base={preview}
                          current={{ nodes: currentNodes || [], edges: currentEdges || [] }}
                        />
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
