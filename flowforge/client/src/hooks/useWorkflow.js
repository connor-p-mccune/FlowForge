import { useEffect, useRef, useCallback } from 'react'
import { apiFetch } from '../services/api'

export function useWorkflow(workflowId, setNodes, setEdges) {
  const saveTimer = useRef(null)

  useEffect(() => {
    if (!workflowId) return
    apiFetch(`/api/workflows/${workflowId}`)
      .then(({ workflow }) => {
        const { nodes, edges } = JSON.parse(workflow.graph_json)
        setNodes(nodes || [])
        setEdges(edges || [])
      })
      .catch((err) => console.error('Failed to load workflow:', err))
  }, [workflowId, setNodes, setEdges])

  const saveGraph = useCallback(
    (nodes, edges) => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        apiFetch(`/api/workflows/${workflowId}/graph`, {
          method: 'PUT',
          body: { nodes, edges },
        }).catch((err) => console.error('Failed to save graph:', err))
      }, 500)
    },
    [workflowId]
  )

  return { saveGraph }
}
