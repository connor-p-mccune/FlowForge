import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, {
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useWorkflow } from '../../hooks/useWorkflow'
import { useSocket } from '../../hooks/useSocket'
import { useAuth } from '../../hooks/useAuth'
import { apiFetch } from '../../services/api'
import CanvasToolbar from './CanvasToolbar'
import NodeConfigPanel from './NodeConfigPanel'
import SuggestionsPanel from './SuggestionsPanel'
import WebhookPanel from './WebhookPanel'
import ExecutionPanel from '../execution/ExecutionPanel'
import CursorOverlay from '../collaboration/CursorOverlay'
import PresenceBar from '../collaboration/PresenceBar'
import { NODE_DEFS } from './nodeDefs'
import TriggerNode from './nodes/TriggerNode'
import ActionNode from './nodes/ActionNode'
import ConditionNode from './nodes/ConditionNode'
import AINode from './nodes/AINode'
import OutputNode from './nodes/OutputNode'

const nodeTypes = {
  'trigger-manual': TriggerNode,
  'trigger-webhook': TriggerNode,
  'action-http': ActionNode,
  'action-delay': ActionNode,
  'action-email': ActionNode,
  'action-slack': ActionNode,
  'transform': ActionNode,
  'condition': ConditionNode,
  'ai-prompt': AINode,
  'ai-classify': AINode,
  'ai-extract': AINode,
  'output-log': OutputNode,
  'output-return': OutputNode,
}

function CanvasInner({ workflowId }) {
  const wrapperRef = useRef(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const { saveGraph } = useWorkflow(workflowId, setNodes, setEdges)
  const { screenToFlowPosition, getNode } = useReactFlow()
  const { user } = useAuth()

  // Execution state (Phase 3)
  const [execution, setExecution] = useState(null) // { id, status, error }
  const [execSteps, setExecSteps] = useState([]) // [{ nodeId, status, output, error }]
  const [execPanelOpen, setExecPanelOpen] = useState(false)
  const executionIdRef = useRef(null)

  // AI suggestions + webhook panel (Phase 5)
  const [suggestions, setSuggestions] = useState(null) // null = panel closed
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState(null)
  const suggestAnchorRef = useRef(null)
  const [webhookOpen, setWebhookOpen] = useState(false)

  const handleExecUpdate = useCallback((payload) => {
    if (payload.kind === 'execution') {
      // Adopt runs we didn't start (e.g. triggered by a collaborator)
      if (payload.status === 'running' && payload.executionId !== executionIdRef.current) {
        executionIdRef.current = payload.executionId
        setExecSteps([])
        setExecution({ id: payload.executionId, status: 'running', error: null })
        setExecPanelOpen(true)
        return
      }
      if (payload.executionId === executionIdRef.current) {
        setExecution((prev) => {
          // never let a late "running" overwrite a terminal state
          if (prev && ['completed', 'failed'].includes(prev.status) && payload.status === 'running') {
            return prev
          }
          return { id: payload.executionId, status: payload.status, error: payload.error }
        })
      }
    } else if (payload.kind === 'step' && payload.executionId === executionIdRef.current) {
      setExecSteps((prev) => {
        const step = {
          nodeId: payload.nodeId,
          status: payload.status,
          output: payload.output,
          error: payload.error,
        }
        const idx = prev.findIndex((s) => s.nodeId === payload.nodeId)
        if (idx === -1) return [...prev, step]
        // same guard for steps: terminal statuses win over late "running"
        const terminal = ['succeeded', 'failed', 'skipped']
        if (terminal.includes(prev[idx].status) && payload.status === 'running') return prev
        const next = [...prev]
        next[idx] = step
        return next
      })
    }
  }, [])

  // Collaboration state (Phase 4)
  const [remoteUsers, setRemoteUsers] = useState([])
  const [remoteCursors, setRemoteCursors] = useState({}) // userId -> { x, y, color, ts }
  const lastLocalEditRef = useRef({}) // elementId -> ts of our latest local edit (LWW)
  const dragEmitRef = useRef({}) // nodeId -> last drag emit ts (throttle)
  const cursorEmitRef = useRef(0)

  const handleRemoteNode = useCallback(
    ({ action, node, ts }) => {
      if (!node?.id) return
      // Last-write-wins: drop remote changes older than our latest local edit
      if (ts && ts < (lastLocalEditRef.current[node.id] || 0)) return
      if (action === 'add') {
        setNodes((nds) => (nds.some((n) => n.id === node.id) ? nds : [...nds, node]))
      } else if (action === 'remove') {
        setNodes((nds) => nds.filter((n) => n.id !== node.id))
        setEdges((eds) => eds.filter((e) => e.source !== node.id && e.target !== node.id))
      } else {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === node.id
              ? {
                  ...n,
                  ...(node.position ? { position: node.position } : {}),
                  ...(node.data ? { data: { ...n.data, ...node.data } } : {}),
                }
              : n
          )
        )
      }
    },
    [setNodes, setEdges]
  )

  const handleRemoteEdge = useCallback(
    ({ action, edge, ts }) => {
      if (!edge?.id) return
      if (ts && ts < (lastLocalEditRef.current[edge.id] || 0)) return
      if (action === 'add') {
        setEdges((eds) => (eds.some((e) => e.id === edge.id) ? eds : [...eds, edge]))
      } else if (action === 'remove') {
        setEdges((eds) => eds.filter((e) => e.id !== edge.id))
      }
    },
    [setEdges]
  )

  const handleRemoteCursor = useCallback(({ userId, color, x, y }) => {
    setRemoteCursors((prev) => ({ ...prev, [userId]: { x, y, color, ts: Date.now() } }))
  }, [])

  const socket = useSocket(workflowId, {
    onExecUpdate: handleExecUpdate,
    onRemoteNode: handleRemoteNode,
    onRemoteEdge: handleRemoteEdge,
    onRemoteCursor: handleRemoteCursor,
    onPresence: ({ users }) => setRemoteUsers(users),
    onUserJoined: (u) =>
      setRemoteUsers((prev) => (prev.some((x) => x.userId === u.userId) ? prev : [...prev, u])),
    onUserLeft: ({ userId }) => {
      setRemoteUsers((prev) => prev.filter((u) => u.userId !== userId))
      setRemoteCursors((prev) => {
        const rest = { ...prev }
        delete rest[userId]
        return rest
      })
    },
  })

  const emitNodeChange = useCallback(
    (action, node) => {
      const ts = Date.now()
      if (node?.id) lastLocalEditRef.current[node.id] = ts
      socket.emit('node-change', { workflowId, action, node, ts })
    },
    [socket, workflowId]
  )

  const emitEdgeChange = useCallback(
    (action, edge) => {
      const ts = Date.now()
      if (edge?.id) lastLocalEditRef.current[edge.id] = ts
      socket.emit('edge-change', { workflowId, action, edge, ts })
    },
    [socket, workflowId]
  )

  // Drop cursors that stopped updating (closed tab, network drop)
  useEffect(() => {
    const id = setInterval(() => {
      setRemoteCursors((prev) => {
        const cutoff = Date.now() - 8000
        const fresh = Object.entries(prev).filter(([, c]) => c.ts > cutoff)
        return fresh.length === Object.keys(prev).length ? prev : Object.fromEntries(fresh)
      })
    }, 4000)
    return () => clearInterval(id)
  }, [])

  const handleMouseMove = useCallback(
    (event) => {
      const now = Date.now()
      if (now - cursorEmitRef.current < 50) return // throttle
      cursorEmitRef.current = now
      const { x, y } = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      socket.emit('cursor-move', { workflowId, x, y })
    },
    [screenToFlowPosition, socket, workflowId]
  )

  const handleRun = useCallback(async () => {
    try {
      const { execution: ex } = await apiFetch(`/api/workflows/${workflowId}/execute`, {
        method: 'POST',
      })
      executionIdRef.current = ex.id
      setExecSteps([])
      setExecution({ id: ex.id, status: ex.status, error: null })
    } catch (err) {
      executionIdRef.current = null
      setExecution({ id: null, status: 'failed', error: err.message })
    }
    setExecPanelOpen(true)
  }, [workflowId])

  // Debounced auto-save whenever the graph changes (no-ops until loaded,
  // and when only volatile props like selection changed)
  useEffect(() => {
    saveGraph(nodes, edges)
  }, [nodes, edges, saveGraph])

  const selectedNode = useMemo(() => nodes.find((n) => n.selected) || null, [nodes])

  // Wrap React Flow's change handlers to broadcast drags and deletions
  const handleNodesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'position') {
          const now = Date.now()
          const last = dragEmitRef.current[change.id] || 0
          if (change.dragging && change.position && now - last > 80) {
            dragEmitRef.current[change.id] = now
            emitNodeChange('update', { id: change.id, position: change.position })
          } else if (!change.dragging) {
            // drag end — always send the final position
            const position = change.position || getNode(change.id)?.position
            if (position) emitNodeChange('update', { id: change.id, position })
          }
        } else if (change.type === 'remove') {
          emitNodeChange('remove', { id: change.id })
        }
      }
      onNodesChange(changes)
    },
    [onNodesChange, emitNodeChange, getNode]
  )

  const handleEdgesChange = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === 'remove') emitEdgeChange('remove', { id: change.id })
      }
      onEdgesChange(changes)
    },
    [onEdgesChange, emitEdgeChange]
  )

  const onConnect = useCallback(
    (params) => {
      const edge = { ...params, id: crypto.randomUUID() }
      setEdges((eds) => addEdge(edge, eds))
      emitEdgeChange('add', edge)
    },
    [setEdges, emitEdgeChange]
  )

  const addNodeOfType = useCallback(
    (type, { label, connectFromId } = {}) => {
      const def = NODE_DEFS[type]
      if (!def) return null

      // Place below the anchor node when wiring from one, else at canvas center
      const anchor = connectFromId ? getNode(connectFromId) : null
      let position
      if (anchor) {
        position = { x: anchor.position.x, y: anchor.position.y + 120 }
      } else {
        const rect = wrapperRef.current.getBoundingClientRect()
        position = screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
      }
      // small jitter so repeated adds don't stack exactly
      position.x += Math.round(Math.random() * 40 - 20)
      position.y += Math.round(Math.random() * 40 - 20)

      const node = {
        id: crypto.randomUUID(),
        type,
        position,
        data: {
          label: label || def.label,
          subtype: def.subtype,
          config: { ...def.config },
        },
      }
      setNodes((nds) => [...nds, node])
      emitNodeChange('add', node)

      if (connectFromId) {
        const edge = { id: crypto.randomUUID(), source: connectFromId, target: node.id }
        setEdges((eds) => addEdge(edge, eds))
        emitEdgeChange('add', edge)
      }
      return node
    },
    [screenToFlowPosition, getNode, setNodes, setEdges, emitNodeChange, emitEdgeChange]
  )

  const handleAddNode = useCallback((type) => addNodeOfType(type), [addNodeOfType])

  const handleSuggest = useCallback(async () => {
    setWebhookOpen(false)
    setSuggestError(null)
    setSuggestLoading(true)
    setSuggestions([])
    const anchor = nodes.find((n) => n.selected) || nodes[nodes.length - 1] || null
    suggestAnchorRef.current = anchor?.id || null
    try {
      const payloadNodes = nodes.map((n) => ({
        id: n.id,
        type: n.type,
        data: { label: n.data?.label },
      }))
      const payloadEdges = edges.map((e) => ({ source: e.source, target: e.target }))
      const { suggestions: result } = await apiFetch('/api/ai/suggest', {
        method: 'POST',
        body: { nodes: payloadNodes, edges: payloadEdges, lastNodeType: anchor?.type || null },
      })
      setSuggestions(result)
    } catch (err) {
      setSuggestError(err.message)
    } finally {
      setSuggestLoading(false)
    }
  }, [nodes, edges])

  const handleAddSuggestion = useCallback(
    (suggestion) => {
      if (!NODE_DEFS[suggestion.type]) {
        setSuggestError(`Unsupported suggested type: ${suggestion.type}`)
        return
      }
      const created = addNodeOfType(suggestion.type, {
        label: suggestion.label,
        connectFromId: suggestAnchorRef.current,
      })
      // Chain further additions from the node we just created
      if (created) suggestAnchorRef.current = created.id
    },
    [addNodeOfType]
  )

  const handleNodeDataChange = useCallback(
    (nodeId, patch) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
      )
      emitNodeChange('update', { id: nodeId, data: patch })
    },
    [setNodes, emitNodeChange]
  )

  const handleDeleteNode = useCallback(
    (nodeId) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      // remote peers prune the connected edges themselves on node remove
      emitNodeChange('remove', { id: nodeId })
    },
    [setNodes, setEdges, emitNodeChange]
  )

  const handleClosePanel = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)))
  }, [setNodes])

  return (
    <div className="canvas-wrapper" ref={wrapperRef} onMouseMove={handleMouseMove}>
      <CanvasToolbar
        onAddNode={handleAddNode}
        onRun={handleRun}
        onToggleRuns={() => setExecPanelOpen((v) => !v)}
        onSuggest={handleSuggest}
        onToggleWebhooks={() => setWebhookOpen((v) => !v)}
        running={execution?.status === 'running' || execution?.status === 'pending'}
        suggesting={suggestLoading}
      />
      <PresenceBar users={remoteUsers} selfId={user?.id} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
      <CursorOverlay cursors={remoteCursors} users={remoteUsers} />
      <NodeConfigPanel
        node={selectedNode}
        onChange={handleNodeDataChange}
        onClose={handleClosePanel}
        onDelete={handleDeleteNode}
      />
      {suggestions !== null && (
        <SuggestionsPanel
          loading={suggestLoading}
          error={suggestError}
          suggestions={suggestions}
          onAdd={handleAddSuggestion}
          onClose={() => setSuggestions(null)}
        />
      )}
      <WebhookPanel
        workflowId={workflowId}
        open={webhookOpen}
        onClose={() => setWebhookOpen(false)}
      />
      <ExecutionPanel
        open={execPanelOpen}
        onClose={() => setExecPanelOpen(false)}
        execution={execution}
        steps={execSteps}
        nodes={nodes}
        workflowId={workflowId}
      />
    </div>
  )
}

export default function WorkflowCanvas({ workflowId }) {
  return (
    <ReactFlowProvider>
      <CanvasInner workflowId={workflowId} />
    </ReactFlowProvider>
  )
}
