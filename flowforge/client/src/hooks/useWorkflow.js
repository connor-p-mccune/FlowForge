import { useEffect, useRef, useState, useCallback } from 'react'
import { apiFetch } from '../services/api'

// Strip volatile React Flow props (selected, dragging, etc.) so the saved
// graph is stable and snapshot comparison doesn't fire on selection changes.
export function serializeGraph(nodes, edges) {
  return {
    nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data })),
    edges: edges.map(({ id, source, target, sourceHandle, targetHandle }) => ({
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? null,
      targetHandle: targetHandle ?? null,
    })),
  }
}

export function useWorkflow(workflowId, setNodes, setEdges) {
  const [workflow, setWorkflow] = useState(null)
  const saveTimer = useRef(null)
  const lastSavedRef = useRef(null)

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    lastSavedRef.current = null
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        const { nodes, edges } = JSON.parse(wf.graph_json)
        lastSavedRef.current = JSON.stringify(serializeGraph(nodes || [], edges || []))
        setNodes(nodes || [])
        setEdges(edges || [])
        setWorkflow(wf)
      })
      .catch((err) => console.error('Failed to load workflow:', err))
    return () => {
      cancelled = true
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [workflowId, setNodes, setEdges])

  const saveGraph = useCallback(
    (nodes, edges) => {
      if (lastSavedRef.current === null) return // initial load not finished
      const graph = serializeGraph(nodes, edges)
      const payload = JSON.stringify(graph)
      if (payload === lastSavedRef.current) return
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        lastSavedRef.current = payload
        apiFetch(`/api/workflows/${workflowId}/graph`, {
          method: 'PUT',
          body: graph,
        }).catch((err) => console.error('Failed to save graph:', err))
      }, 500)
    },
    [workflowId]
  )

  return { workflow, saveGraph }
}
