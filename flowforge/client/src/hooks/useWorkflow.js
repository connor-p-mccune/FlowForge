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
  // Canvas comments (Figma-style). Loaded here when the workflow opens; the canvas
  // owns live mutations (socket events + optimistic add/reply/resolve) through
  // setComments. viewerIsOwner gates showing the Resolve action on threads the
  // viewer didn't author — the server still enforces the permission.
  const [comments, setComments] = useState([])
  const [viewerIsOwner, setViewerIsOwner] = useState(false)
  const saveTimer = useRef(null)
  const lastSavedRef = useRef(null)
  const lastSaveErrorAt = useRef(0)

  // Toast kept in a ref so save/load closures never need it in their deps.
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  // Load a workflow's graph onto the canvas and record it as the last-saved
  // state, so the debounced auto-save doesn't immediately re-save what we just
  // loaded. Used for the initial load and after a version restore.
  const applyWorkflow = useCallback(
    (wf) => {
      const parsed = JSON.parse(wf.graph_json)
      const nodes = parsed.nodes || []
      const edges = parsed.edges || []
      lastSavedRef.current = JSON.stringify(serializeGraph(nodes, edges))
      setNodes(nodes)
      setEdges(edges)
      setWorkflow(wf)
    },
    [setNodes, setEdges]
  )

  useEffect(() => {
    if (!workflowId) return
    let cancelled = false
    lastSavedRef.current = null
    setLoading(true)
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow: wf }) => {
        if (cancelled) return
        applyWorkflow(wf)
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
  }, [workflowId, applyWorkflow])

  // Load existing (unresolved) comments when the workflow opens. Kept separate
  // from the graph load so a comments hiccup never blocks the canvas, and reset
  // when switching workflows.
  useEffect(() => {
    if (!workflowId) {
      setComments([])
      setViewerIsOwner(false)
      return
    }
    let cancelled = false
    apiFetch(`/api/workflows/${workflowId}/comments`)
      .then(({ comments: loaded, viewerIsOwner: owner }) => {
        if (cancelled) return
        setComments(loaded || [])
        setViewerIsOwner(Boolean(owner))
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load comments:', err)
      })
    return () => {
      cancelled = true
    }
  }, [workflowId])

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

  // Deploy: persist the live graph (cancelling any pending debounced save so the
  // snapshot matches exactly what's on the canvas), then record it as a new
  // version on the server. Returns the created version row.
  const deploy = useCallback(
    async (nodes, edges) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      const graph = serializeGraph(nodes, edges)
      const payload = JSON.stringify(graph)
      if (payload !== lastSavedRef.current) {
        await apiFetch(`/api/workflows/${workflowId}/graph`, { method: 'PUT', body: graph })
        lastSavedRef.current = payload
      }
      const { version } = await apiFetch(`/api/workflows/${workflowId}/deploy`, { method: 'POST' })
      return version
    },
    [workflowId]
  )

  // Pause / resume the workflow (the operational kill switch). Hits the
  // idempotent server routes and folds the returned row into local state so
  // paused_at is reflected immediately without a reload. Returns the fresh row.
  const setPaused = useCallback(
    async (paused) => {
      const action = paused ? 'pause' : 'resume'
      const { workflow: wf } = await apiFetch(`/api/workflows/${workflowId}/${action}`, {
        method: 'POST',
      })
      setWorkflow((prev) => (prev ? { ...prev, ...wf } : wf))
      return wf
    },
    [workflowId]
  )

  return {
    workflow,
    saveGraph,
    loading,
    deploy,
    setPaused,
    applyWorkflow,
    comments,
    setComments,
    viewerIsOwner,
  }
}
