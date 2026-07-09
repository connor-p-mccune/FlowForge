import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import ReactFlow, {
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useWorkflow } from '../../hooks/useWorkflow'
import { useUndoRedo } from '../../hooks/useUndoRedo'
import { useSocket } from '../../hooks/useSocket'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../../hooks/useToast'
import { apiFetch } from '../../services/api'
import Skeleton from '../Skeleton'
import CanvasToolbar from './CanvasToolbar'
import NodeConfigPanel from './NodeConfigPanel'
import SuggestionsPanel from './SuggestionsPanel'
import GenerateModal from './GenerateModal'
import WebhookPanel from './WebhookPanel'
import HistoryPanel from './HistoryPanel'
import IssuesPanel from './IssuesPanel'
import ExecutionPanel from '../execution/ExecutionPanel'
import CursorOverlay from '../collaboration/CursorOverlay'
import CommentsOverlay from '../collaboration/CommentsOverlay'
import PresenceBar from '../collaboration/PresenceBar'
import { NODE_DEFS } from './nodeDefs'
import { nodeTypes } from './nodeTypes'
import { layoutGraph } from '../../utils/autoLayout'
import { makeDuplicate } from '../../utils/nodeOps'

// Shown for any generation failure — the model may have returned something
// unusable, the prompt may be too vague, or the AI service may be unreachable.
const GENERATE_ERROR_MESSAGE =
  'The AI couldn’t generate a valid workflow for that description — try being more specific about the trigger and actions'

function CanvasInner({ workflowId }) {
  const wrapperRef = useRef(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const { workflow, saveGraph, loading, deploy, applyWorkflow, comments, setComments, viewerIsOwner } =
    useWorkflow(workflowId, setNodes, setEdges)
  const { screenToFlowPosition, getNode, fitView, setCenter } = useReactFlow()
  const { user } = useAuth()

  // Toast (kept in a ref so the socket/exec callbacks below need no deps churn).
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const failToastedRef = useRef(null) // executionId we've already toasted a failure for
  const connToastRef = useRef(null) // id of the active "connection lost" toast

  // Execution state (Phase 3)
  const [execution, setExecution] = useState(null) // { id, status, error }
  const [execSteps, setExecSteps] = useState([]) // [{ nodeId, status, output, error }]
  const [execPanelOpen, setExecPanelOpen] = useState(false)
  // Whether the current/last run is a dry run (Test). Drives the test-mode banner;
  // the per-node "Would send" badges derive from the step outputs themselves.
  const [isTestRun, setIsTestRun] = useState(false)
  const executionIdRef = useRef(null)

  // Deep link from a notification: /workflow/:id?execution=<id> opens the runs
  // panel straight to that run's history (see ExecutionPanel/ExecutionHistory).
  const [searchParams] = useSearchParams()
  const deepLinkExecId = searchParams.get('execution')
  useEffect(() => {
    if (deepLinkExecId) setExecPanelOpen(true)
  }, [deepLinkExecId])

  // AI suggestions + webhook panel (Phase 5)
  const [suggestions, setSuggestions] = useState(null) // null = panel closed
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState(null)
  const suggestAnchorRef = useRef(null)
  const [webhookOpen, setWebhookOpen] = useState(false)

  // AI workflow generation (natural-language description → full graph)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)
  const [pendingGraph, setPendingGraph] = useState(null) // graph awaiting replace-confirm

  // Lint results for the live canvas (Issues panel)
  const [issuesOpen, setIssuesOpen] = useState(false)

  // Version history (deploy / restore)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyReload, setHistoryReload] = useState(0)
  const [deploying, setDeploying] = useState(false)
  // Whether the live graph is deployed — drives the schedule warning. Synced from
  // the loaded workflow's status, set true on a successful deploy, and reset false
  // when the schedule node is added/edited (the running cron is then stale until
  // the user redeploys).
  const [deployed, setDeployed] = useState(false)
  useEffect(() => {
    setDeployed(workflow?.status === 'deployed')
  }, [workflow])
  const hasSchedule = useMemo(() => nodes.some((n) => n.type === 'trigger-schedule'), [nodes])

  const handleExecUpdate = useCallback((payload) => {
    if (payload.kind === 'execution') {
      // Adopt runs we didn't start (e.g. triggered by a collaborator)
      if (payload.status === 'running' && payload.executionId !== executionIdRef.current) {
        executionIdRef.current = payload.executionId
        setExecSteps([])
        setIsTestRun(Boolean(payload.dryRun))
        setExecution({ id: payload.executionId, status: 'running', error: null })
        setExecPanelOpen(true)
        return
      }
      if (payload.executionId === executionIdRef.current) {
        setExecution((prev) => {
          // never let a late "running" overwrite a terminal state
          if (
            prev &&
            ['completed', 'failed', 'cancelled'].includes(prev.status) &&
            payload.status === 'running'
          ) {
            return prev
          }
          return { id: payload.executionId, status: payload.status, error: payload.error }
        })
        // Surface a run failure as a toast (once per execution) in case the
        // execution panel is closed.
        if (payload.status === 'failed' && failToastedRef.current !== payload.executionId) {
          failToastedRef.current = payload.executionId
          toastRef.current.error(payload.error || 'Workflow run failed')
        }
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

  // Canvas comments (Figma-style). commentMode flips the canvas into placement
  // mode (crosshair + click-to-comment); draft holds the pending new-comment
  // position in flow coords while its composer is open; openCommentId is the
  // thread whose popover is showing. The comment list + viewerIsOwner come from
  // useWorkflow; live mutations go through the merge helpers below.
  const [commentMode, setCommentMode] = useState(false)
  const [draft, setDraft] = useState(null)
  const [openCommentId, setOpenCommentId] = useState(null)

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

  // Live comment merges. All dedupe by id so a sender receiving its own broadcast
  // echo (io.to(room) includes the sender) stays idempotent with the optimistic
  // update it already applied from its own HTTP response.
  const upsertComment = useCallback(
    (comment) => {
      if (!comment?.id) return
      setComments((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]))
    },
    [setComments]
  )

  const addReplyToComment = useCallback(
    (reply) => {
      if (!reply?.comment_id) return
      setComments((prev) =>
        prev.map((c) =>
          c.id === reply.comment_id
            ? {
                ...c,
                replies: (c.replies || []).some((r) => r.id === reply.id)
                  ? c.replies
                  : [...(c.replies || []), reply],
              }
            : c
        )
      )
    },
    [setComments]
  )

  const removeComment = useCallback(
    (commentId) => {
      setComments((prev) => prev.filter((c) => c.id !== commentId))
      setOpenCommentId((cur) => (cur === commentId ? null : cur))
    },
    [setComments]
  )

  const socket = useSocket(workflowId, {
    onExecUpdate: handleExecUpdate,
    onRemoteNode: handleRemoteNode,
    onRemoteEdge: handleRemoteEdge,
    onRemoteCursor: handleRemoteCursor,
    onCommentAdded: ({ comment }) => upsertComment(comment),
    onCommentReplyAdded: ({ reply }) => addReplyToComment(reply),
    onCommentResolved: ({ commentId }) => removeComment(commentId),
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
    onConnectionLost: () => {
      if (connToastRef.current == null) {
        connToastRef.current = toastRef.current.error(
          'Connection lost — live collaboration is paused while we reconnect.',
          { duration: 0 }
        )
      }
    },
    onReconnect: () => {
      if (connToastRef.current != null) {
        toastRef.current.dismiss(connToastRef.current)
        connToastRef.current = null
      }
      toastRef.current.success('Reconnected.')
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

  // Undo/redo over debounced graph snapshots. Applying a step broadcasts the
  // node/edge differences through the same channel as live edits, so
  // collaborators converge on the undone state.
  const { undo, redo, canUndo, canRedo } = useUndoRedo({
    ready: !loading && Boolean(workflow),
    nodes,
    edges,
    setNodes,
    setEdges,
    emitNodeChange,
    emitEdgeChange,
  })

  // Ctrl/⌘-D duplicates the selected node: fresh id, deep-copied config,
  // offset position, selection moved to the copy, broadcast to peers.
  const handleDuplicate = useCallback(() => {
    const source = nodes.find((n) => n.selected)
    if (!source) return
    const copy = makeDuplicate(source)
    setNodes((nds) =>
      nds
        .map((n) => (n.selected ? { ...n, selected: false } : n))
        .concat({ ...copy, selected: true })
    )
    emitNodeChange('add', copy)
  }, [nodes, setNodes, emitNodeChange])

  // Ctrl/⌘-Z undoes, Ctrl/⌘-Shift-Z (or Ctrl-Y) redoes, Ctrl/⌘-D duplicates —
  // except while typing in a field, where the browser's own behavior must
  // keep working.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return
      const tag = event.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault()
        redo()
      } else if (key === 'd') {
        event.preventDefault()
        handleDuplicate()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo, handleDuplicate])

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
    setIsTestRun(false)
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
      toastRef.current.error(`Couldn’t start run: ${err.message}`)
    }
    setExecPanelOpen(true)
  }, [workflowId])

  // Test mode: same as Run but a dry run — action nodes (email/Slack/HTTP) report
  // what they would have sent instead of firing. Results show as "Would send"
  // badges on the canvas (derived from each step's output below).
  const handleTest = useCallback(async () => {
    setIsTestRun(true)
    try {
      const { execution: ex } = await apiFetch(`/api/workflows/${workflowId}/test`, {
        method: 'POST',
      })
      executionIdRef.current = ex.id
      setExecSteps([])
      setExecution({ id: ex.id, status: ex.status, error: null })
    } catch (err) {
      executionIdRef.current = null
      setExecution({ id: null, status: 'failed', error: err.message })
      toastRef.current.error(`Couldn’t start test run: ${err.message}`)
    }
    setExecPanelOpen(true)
  }, [workflowId])

  // Stop the current run. Cooperative: the engine finishes the node in flight,
  // then skips the rest — the 'cancelled' status arrives over the socket like
  // any other execution update.
  const handleCancelRun = useCallback(async () => {
    const id = executionIdRef.current
    if (!id) return
    try {
      await apiFetch(`/api/executions/${id}/cancel`, { method: 'POST' })
    } catch (err) {
      toastRef.current.error(`Couldn’t stop this run: ${err.message}`)
    }
  }, [])

  // Deploy the current canvas as a new version, then nudge the history drawer to
  // refresh if it's open so the new version appears.
  const handleDeploy = useCallback(async () => {
    setDeploying(true)
    try {
      const version = await deploy(nodes, edges)
      setDeployed(true)
      toastRef.current.success(`Deployed — saved as version ${version.version}.`)
      setHistoryReload((n) => n + 1)
    } catch (err) {
      toastRef.current.error(`Couldn’t deploy: ${err.message}`)
    } finally {
      setDeploying(false)
    }
  }, [deploy, nodes, edges])

  // The right-side panels (history / webhooks / suggestions) share screen space,
  // so opening one closes the others. The Issues panel lives on the left and
  // coexists with the config panel, but still yields to the big right drawers.
  const handleToggleHistory = useCallback(() => {
    setHistoryOpen((v) => !v)
    setWebhookOpen(false)
    setSuggestions(null)
  }, [])

  const handleToggleWebhooks = useCallback(() => {
    setWebhookOpen((v) => !v)
    setHistoryOpen(false)
    setSuggestions(null)
  }, [])

  const handleToggleIssues = useCallback(() => setIssuesOpen((v) => !v), [])

  // Clicking an issue selects the offending node (opening its config panel)
  // and pans the viewport to it.
  const handleSelectIssueNode = useCallback(
    (nodeId) => {
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })))
      const target = getNode(nodeId)
      if (target) {
        const w = target.width || 160
        const h = target.height || 60
        setCenter(target.position.x + w / 2, target.position.y + h / 2, {
          zoom: 1.1,
          duration: 300,
        })
      }
    },
    [setNodes, getNode, setCenter]
  )

  // After a restore the server has already swapped the live graph; load it onto
  // the canvas (which also resyncs the auto-save baseline) and close the drawer.
  const handleRestored = useCallback(
    (updatedWorkflow) => {
      applyWorkflow(updatedWorkflow)
      setHistoryOpen(false)
      toastRef.current.success('Workflow restored.')
    },
    [applyWorkflow]
  )

  // Debounced auto-save whenever the graph changes (no-ops until loaded,
  // and when only volatile props like selection changed)
  useEffect(() => {
    saveGraph(nodes, edges)
  }, [nodes, edges, saveGraph])

  const selectedNode = useMemo(() => nodes.find((n) => n.selected) || null, [nodes])

  // Dry-run results, keyed by node id, derived from the current run's step outputs
  // (a step's output is { dryRun: true, wouldHaveSent }). Cleared automatically
  // whenever a new run resets execSteps, so badges only reflect the latest run.
  const dryRunByNode = useMemo(() => {
    const map = {}
    for (const s of execSteps) {
      if (s.output?.dryRun && s.output.wouldHaveSent) map[s.nodeId] = s.output.wouldHaveSent
    }
    return map
  }, [execSteps])

  // Merge dry-run results into node data for rendering only — never into the
  // `nodes` state itself, which is what the debounced auto-save persists. When
  // there are no results this returns the same array reference (no-op).
  const displayNodes = useMemo(() => {
    if (Object.keys(dryRunByNode).length === 0) return nodes
    return nodes.map((n) =>
      dryRunByNode[n.id] ? { ...n, data: { ...n.data, dryRunResult: dryRunByNode[n.id] } } : n
    )
  }, [nodes, dryRunByNode])

  // The test-mode banner shows only while a dry run is actively executing.
  const testBannerVisible =
    isTestRun && (execution?.status === 'pending' || execution?.status === 'running')

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
      // A newly added schedule node isn't active until the workflow is deployed.
      if (type === 'trigger-schedule') setDeployed(false)

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

  // Tidy: re-arrange the graph into clean layers (layered DAG layout), then
  // broadcast every node that actually moved so collaborators see the same
  // arrangement, and frame the result.
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return
    const laidOut = layoutGraph(nodes, edges)
    const moved = laidOut.filter((n, i) => {
      const prev = nodes[i].position
      return prev.x !== n.position.x || prev.y !== n.position.y
    })
    setNodes(laidOut)
    for (const n of moved) emitNodeChange('update', { id: n.id, position: n.position })
    setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60)
  }, [nodes, edges, setNodes, emitNodeChange, fitView])

  const handleSuggest = useCallback(async () => {
    setWebhookOpen(false)
    setHistoryOpen(false)
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

  // Load an AI-generated graph onto the canvas. Normalizes each node to the shape
  // the canvas + runners expect (merging in NODE_DEFS config defaults), selects
  // the first node so its config panel opens for review, then lets the debounced
  // auto-save persist it. Unlike applyWorkflow (restore), this is a brand-new
  // graph the user should review node-by-node, so we don't touch the save baseline.
  const applyGeneratedGraph = useCallback(
    (graphData) => {
      const rawNodes = Array.isArray(graphData?.nodes) ? graphData.nodes : []
      const rawEdges = Array.isArray(graphData?.edges) ? graphData.edges : []
      const newNodes = rawNodes.map((n, i) => {
        const def = NODE_DEFS[n.type]
        const pos =
          n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y)
            ? n.position
            : { x: 250, y: 60 + i * 140 }
        return {
          id: n.id || crypto.randomUUID(),
          type: n.type,
          position: pos,
          selected: i === 0, // open the config panel on the first node
          data: {
            label: n.data?.label || def?.label || n.type,
            subtype: def?.subtype || n.type.replace(/^[^-]+-/, '') || n.type,
            config: { ...(def?.config || {}), ...(n.data?.config || {}) },
          },
        }
      })
      const newEdges = rawEdges.map((e) => ({
        id: e.id || crypto.randomUUID(),
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }))
      setNodes(newNodes)
      setEdges(newEdges)
      // Frame the new graph once React Flow has measured the nodes.
      setTimeout(() => fitView({ padding: 0.2, duration: 300 }), 60)
    },
    [setNodes, setEdges, fitView]
  )

  const handleOpenGenerate = useCallback(() => {
    // Share screen space with the other panels.
    setWebhookOpen(false)
    setHistoryOpen(false)
    setSuggestions(null)
    setGenerateError(null)
    setPendingGraph(null)
    setGenerateOpen(true)
  }, [])

  const handleGenerate = useCallback(
    async (prompt) => {
      setGenerating(true)
      setGenerateError(null)
      try {
        const { graph_data: graphData } = await apiFetch('/api/ai/generate', {
          method: 'POST',
          body: { prompt },
        })
        if (!graphData || !Array.isArray(graphData.nodes) || graphData.nodes.length === 0) {
          throw new Error('empty graph')
        }
        if (nodes.length === 0) {
          applyGeneratedGraph(graphData)
          setGenerateOpen(false)
          toastRef.current.success('Workflow generated — review each node’s config.')
        } else {
          // Canvas already has nodes — confirm before overwriting them.
          setPendingGraph(graphData)
        }
      } catch (err) {
        console.error('AI generate failed:', err)
        setGenerateError(GENERATE_ERROR_MESSAGE)
      } finally {
        setGenerating(false)
      }
    },
    [nodes.length, applyGeneratedGraph]
  )

  const handleConfirmReplace = useCallback(() => {
    if (pendingGraph) applyGeneratedGraph(pendingGraph)
    setPendingGraph(null)
    setGenerateOpen(false)
    toastRef.current.success('Workflow generated — review each node’s config.')
  }, [pendingGraph, applyGeneratedGraph])

  const handleCancelReplace = useCallback(() => setPendingGraph(null), [])

  const handleNodeDataChange = useCallback(
    (nodeId, patch) => {
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
      )
      emitNodeChange('update', { id: nodeId, data: patch })
      // Editing a schedule node makes the live cron job stale until it's redeployed.
      if (nodes.find((n) => n.id === nodeId)?.type === 'trigger-schedule') setDeployed(false)
    },
    [setNodes, emitNodeChange, nodes]
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

  const toggleCommentMode = useCallback(() => {
    setOpenCommentId(null)
    setCommentMode((on) => {
      if (on) setDraft(null) // leaving comment mode cancels a pending draft
      return !on
    })
  }, [])

  // Placing a comment: right-click does it anywhere; a left-click does it only in
  // comment mode. Either way an open thread closes. These fire only on the canvas
  // background — React Flow never fires pane events for a click on a node.
  const handlePaneClick = useCallback(
    (event) => {
      setOpenCommentId(null)
      setDraft(commentMode ? screenToFlowPosition({ x: event.clientX, y: event.clientY }) : null)
    },
    [commentMode, screenToFlowPosition]
  )

  const handlePaneContextMenu = useCallback(
    (event) => {
      event.preventDefault()
      setOpenCommentId(null)
      setDraft(screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [screenToFlowPosition]
  )

  const handleSubmitComment = useCallback(
    async (content) => {
      if (!draft) return
      try {
        const { comment } = await apiFetch(`/api/workflows/${workflowId}/comments`, {
          method: 'POST',
          body: { x: draft.x, y: draft.y, content },
        })
        upsertComment(comment) // dedupes against the live echo
        setDraft(null)
      } catch (err) {
        toastRef.current.error(`Couldn’t post comment: ${err.message}`)
      }
    },
    [draft, workflowId, upsertComment]
  )

  const handleReply = useCallback(
    async (commentId, content) => {
      try {
        const { reply } = await apiFetch(`/api/comments/${commentId}/replies`, {
          method: 'POST',
          body: { content },
        })
        addReplyToComment(reply)
      } catch (err) {
        toastRef.current.error(`Couldn’t post reply: ${err.message}`)
      }
    },
    [addReplyToComment]
  )

  const handleResolve = useCallback(
    async (commentId) => {
      try {
        await apiFetch(`/api/comments/${commentId}/resolve`, { method: 'PUT' })
        removeComment(commentId)
      } catch (err) {
        toastRef.current.error(`Couldn’t resolve this comment: ${err.message}`)
      }
    },
    [removeComment]
  )

  return (
    <div
      className={`canvas-wrapper${commentMode ? ' canvas-wrapper--commenting' : ''}`}
      ref={wrapperRef}
      onMouseMove={handleMouseMove}
    >
      <CanvasToolbar
        onAddNode={handleAddNode}
        onRun={handleRun}
        onTest={handleTest}
        onToggleRuns={() => setExecPanelOpen((v) => !v)}
        onSuggest={handleSuggest}
        onGenerate={handleOpenGenerate}
        onToggleWebhooks={handleToggleWebhooks}
        onToggleCommentMode={toggleCommentMode}
        commentMode={commentMode}
        onAutoLayout={handleAutoLayout}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onToggleIssues={handleToggleIssues}
        issuesOpen={issuesOpen}
        onDeploy={handleDeploy}
        onToggleHistory={handleToggleHistory}
        running={execution?.status === 'running' || execution?.status === 'pending'}
        testing={testBannerVisible}
        suggesting={suggestLoading}
        generating={generating}
        deploying={deploying}
        scheduleWarning={hasSchedule && !deployed}
      />
      <PresenceBar users={remoteUsers} selfId={user?.id} />
      {testBannerVisible && (
        <div className="canvas-test-banner" role="status">
          ⚡ Test mode — action nodes will not fire
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onPaneClick={handlePaneClick}
        onPaneContextMenu={handlePaneContextMenu}
        nodeTypes={nodeTypes}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap className="canvas-minimap" pannable zoomable />
      </ReactFlow>
      {loading && (
        <div className="canvas-loading">
          <div className="canvas-loading__nodes">
            <Skeleton width={160} height={58} radius={10} />
            <Skeleton width={160} height={58} radius={10} />
            <Skeleton width={160} height={58} radius={10} />
          </div>
          <p className="canvas-loading__label">Loading workflow…</p>
        </div>
      )}
      {!loading && nodes.length === 0 && (
        <div className="canvas-empty">
          <p className="canvas-empty__title">This canvas is empty</p>
          <p className="canvas-empty__hint">
            Add a node from the toolbar above to get started — or hit ✨ Suggest for ideas.
          </p>
        </div>
      )}
      <CursorOverlay cursors={remoteCursors} users={remoteUsers} />
      <CommentsOverlay
        comments={comments}
        draft={draft}
        openCommentId={openCommentId}
        viewerIsOwner={viewerIsOwner}
        currentUser={user}
        onOpenThread={setOpenCommentId}
        onCloseThread={() => setOpenCommentId(null)}
        onSubmitDraft={handleSubmitComment}
        onCancelDraft={() => setDraft(null)}
        onReply={handleReply}
        onResolve={handleResolve}
      />
      <NodeConfigPanel
        node={selectedNode}
        onChange={handleNodeDataChange}
        onClose={handleClosePanel}
        onDelete={handleDeleteNode}
        workspaceId={workflow?.workspace_id}
        currentWorkflowId={workflowId}
        nodes={nodes}
        edges={edges}
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
      {generateOpen && (
        <GenerateModal
          generating={generating}
          error={generateError}
          confirmReplace={pendingGraph !== null}
          onSubmit={handleGenerate}
          onConfirmReplace={handleConfirmReplace}
          onCancelReplace={handleCancelReplace}
          onClose={() => {
            setGenerateOpen(false)
            setPendingGraph(null)
            setGenerateError(null)
          }}
        />
      )}
      <WebhookPanel
        workflowId={workflowId}
        open={webhookOpen}
        onClose={() => setWebhookOpen(false)}
      />
      {issuesOpen && (
        <IssuesPanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          onClose={() => setIssuesOpen(false)}
          onSelectNode={handleSelectIssueNode}
        />
      )}
      <HistoryPanel
        workflowId={workflowId}
        open={historyOpen}
        reloadSignal={historyReload}
        onClose={() => setHistoryOpen(false)}
        onRestored={handleRestored}
        currentNodes={nodes}
        currentEdges={edges}
      />
      <ExecutionPanel
        open={execPanelOpen}
        onClose={() => setExecPanelOpen(false)}
        execution={execution}
        steps={execSteps}
        nodes={nodes}
        workflowId={workflowId}
        initialHistoryExecId={deepLinkExecId}
        onCancel={handleCancelRun}
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
