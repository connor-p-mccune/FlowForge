import { useEffect, useRef, useState, useCallback } from 'react'
import { apiFetch } from '../services/api'
import { useToast } from './useToast'

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
  const [loading, setLoading] = useState(true)
  const saveTimer = useRef(null)
  const lastSavedRef = useRef(null)
  const lastSaveErrorAt = useRef(0)

  // Toast kept in a ref so save/load closures never need it in their deps.
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    lastSavedRef.current = null
    setLoading(true)
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        const { nodes, edges } = JSON.parse(wf.graph_json)
        lastSavedRef.current = JSON.stringify(serializeGraph(nodes || [], edges || []))
        setNodes(nodes || [])
        setEdges(edges || [])
        setWorkflow(wf)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load workflow:', err)
        toastRef.current.error(`Couldn’t load this workflow: ${err.message}`)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
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
        // Only mark as saved once the request actually succeeds — on failure
        // lastSavedRef stays put so the next edit retries the save.
        apiFetch(`/api/workflows/${workflowId}/graph`, {
          method: 'PUT',
          body: graph,
        })
          .then(() => {
            lastSavedRef.current = payload
          })
          .catch((err) => {
            console.error('Failed to save graph:', err)
            // Throttle so a sustained outage doesn't spam a toast per keystroke.
            const now = Date.now()
            if (now - lastSaveErrorAt.current > 8000) {
              lastSaveErrorAt.current = now
              toastRef.current.error('Failed to save changes — will retry on next edit.')
            }
          })
      }, 500)
    },
    [workflowId]
  )

  return { workflow, saveGraph, loading }
}
