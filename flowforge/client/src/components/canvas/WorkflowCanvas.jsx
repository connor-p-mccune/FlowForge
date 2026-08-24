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
import { useWorkflow, serializeGraph } from '../../hooks/useWorkflow'
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
import RunSettingsPanel from './RunSettingsPanel'
import BackfillPanel from './BackfillPanel'
import InsightsPanel from './InsightsPanel'
import CanaryPanel from './CanaryPanel'
import TestsPanel from './TestsPanel'
import HistoryPanel from './HistoryPanel'
import {
  createClock,
  observe,
  nodeOps,
  edgeOps,
  applyEffect,
  reconcileSnapshot,
} from '../../services/graphOps'
import IssuesPanel from './IssuesPanel'
import LineagePanel from './LineagePanel'
import ConvergencePanel from './ConvergencePanel'
import ContractGate from './ContractGate'
import GuaranteesPanel from './GuaranteesPanel'
import FlowTextPanel from './FlowTextPanel'
import PathsPanel from './PathsPanel'
import PreviewPanel from './PreviewPanel'
import DebuggerPanel from './DebuggerPanel'
import MergeModal from './MergeModal'
import ExecutionPanel from '../execution/ExecutionPanel'
import CursorOverlay from '../collaboration/CursorOverlay'
import CommentsOverlay from '../collaboration/CommentsOverlay'
import PresenceBar from '../collaboration/PresenceBar'
import { NODE_DEFS } from './nodeDefs'
import { nodeTypes } from './nodeTypes'
import { layoutGraph } from '../../utils/autoLayout'
import { makeDuplicate, decorateConditionEdges, decorateCollidingEdges } from '../../utils/nodeOps'

// Shown for any generation failure — the model may have returned something
// unusable, the prompt may be too vague, or the AI service may be unreachable.
const GENERATE_ERROR_MESSAGE =
  'The AI couldn’t generate a valid workflow for that description — try being more specific about the trigger and actions'

function CanvasInner({ workflowId }) {
  const wrapperRef = useRef(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const {
    workflow,
    saveGraph,
    loading,
    deploy,
    setPaused,
    applyWorkflow,
    comments,
    setComments,
    viewerIsOwner,
  } = useWorkflow(workflowId, setNodes, setEdges)
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

  // Per-workflow run limits (concurrency cap + at-limit policy)
  const [runSettingsOpen, setRunSettingsOpen] = useState(false)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [canaryOpen, setCanaryOpen] = useState(false)
  const [testsOpen, setTestsOpen] = useState(false)

  // AI workflow generation (natural-language description → full graph)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState(null)
  const [pendingGraph, setPendingGraph] = useState(null) // graph awaiting replace-confirm

  // Lint results for the live canvas (Issues panel)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const [lineageOpen, setLineageOpen] = useState(false)
  const [guaranteesOpen, setGuaranteesOpen] = useState(false)
  const [flowTextOpen, setFlowTextOpen] = useState(false)
  const [pathsOpen, setPathsOpen] = useState(false)
  const [convergenceOpen, setConvergenceOpen] = useState(false)
  // Held here rather than in the panel because it decorates the *canvas*: the
  // panel owns the fetch, the edges own the drawing.
  const [convergence, setConvergence] = useState(null)
  // The contract report that stopped a deploy, or null. Cleared either way once
  // the author has answered.
  const [contractGate, setContractGate] = useState(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  // The pause this run is currently sitting at, or null. Driven by the
  // `debug` exec-update, which is why a collaborator watching the same run sees
  // it stop too — a breakpoint is a property of the run, so everybody in the
  // room is looking at the same paused node.
  const [debuggerOpen, setDebuggerOpen] = useState(false)
  const [activeBreak, setActiveBreak] = useState(null)
  const [mergeOpen, setMergeOpen] = useState(false)

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

  // Operational kill switch. paused derives from the loaded workflow row and
  // updates when the toggle below folds the server's response back in.
  const paused = Boolean(workflow?.paused_at)
  const [pausing, setPausing] = useState(false)

  // Approval gates waiting on the current run: nodeId -> { id, message,
  // expiresAt }. Set by 'approval' events off the exec-update channel; an
  // entry clears when its step settles (the responder's decision arrives as
  // an ordinary step event) or when a new run starts.
  const [pendingApprovals, setPendingApprovals] = useState({})

  // Wait-for-callback gates on the current run: nodeId -> { url, expiresAt }.
  // Same lifecycle as approvals — set by 'callback' events, cleared when the
  // step settles or a new run starts — so the run panel can show the one-time
  // URL while the run waits on an external system.
  const [pendingCallbacks, setPendingCallbacks] = useState({})

  const handleExecUpdate = useCallback((payload) => {
    if (payload.kind === 'execution') {
      // Adopt runs we didn't start (e.g. triggered by a collaborator)
      if (payload.status === 'running' && payload.executionId !== executionIdRef.current) {
        executionIdRef.current = payload.executionId
        setExecSteps([])
        setPendingApprovals({})
        setPendingCallbacks({})
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
    } else if (payload.kind === 'debug' && payload.executionId === executionIdRef.current) {
      // The run stopped at a node — or started again. Opening the panel on a
      // pause is deliberate: the run is not going anywhere until somebody acts,
      // so hiding that behind a closed panel would look like it had hung.
      if (payload.status === 'paused') {
        setActiveBreak({
          breakId: payload.breakId,
          nodeId: payload.nodeId,
          nodeLabel: payload.nodeLabel,
          input: payload.input,
          config: payload.config,
          expiresAt: payload.expiresAt,
        })
        setDebuggerOpen(true)
      } else {
        setActiveBreak((prev) => (prev?.breakId === payload.breakId ? null : prev))
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
        const terminal = ['succeeded', 'failed', 'skipped', 'caught', 'reused', 'cached']
        if (terminal.includes(prev[idx].status) && payload.status === 'running') return prev
        const next = [...prev]
        next[idx] = step
        return next
      })
      // The gate settled (someone responded, timeout, cancel) — drop its controls.
      if (payload.status !== 'running') {
        setPendingApprovals((prev) => {
          if (!prev[payload.nodeId]) return prev
          const rest = { ...prev }
          delete rest[payload.nodeId]
          return rest
        })
        setPendingCallbacks((prev) => {
          if (!prev[payload.nodeId]) return prev
          const rest = { ...prev }
          delete rest[payload.nodeId]
          return rest
        })
      }
    } else if (
      payload.kind === 'approval' &&
      payload.executionId === executionIdRef.current &&
      payload.status === 'pending'
    ) {
      setPendingApprovals((prev) => ({
        ...prev,
        [payload.nodeId]: {
          id: payload.approvalId,
          message: payload.message,
          expiresAt: payload.expiresAt,
          // The declared gate, so the panel can say "0 of 3 approvals,
          // workspace owners only" rather than offering two buttons and
          // letting somebody discover the rule by being refused.
          quorum: payload.quorum,
          requiredRole: payload.requiredRole,
          separationOfDuties: payload.separationOfDuties,
          approvals: 0,
        },
      }))
    } else if (
      payload.kind === 'callback' &&
      payload.executionId === executionIdRef.current &&
      payload.status === 'waiting'
    ) {
      setPendingCallbacks((prev) => ({
        ...prev,
        [payload.nodeId]: { url: payload.url, expiresAt: payload.expiresAt },
      }))
    }
  }, [])

  // Collaboration state (Phase 4)
  const [remoteUsers, setRemoteUsers] = useState([])
  const [remoteCursors, setRemoteCursors] = useState({}) // userId -> { x, y, color, ts }
  const dragEmitRef = useRef({}) // nodeId -> last drag emit ts (throttle)
  const cursorEmitRef = useRef(0)

  // Collaboration state (services/graphOps.js). The clock stamps every local
  // edit — it has to be assigned when the edit is *made*, including offline, or
  // a queued edit would rejoin with a timestamp from the past and lose to
  // changes it should have beaten. `syncRef` is our position in the server's
  // session, which is what a resync asks from. `pendingRef` holds operations
  // made while the socket was down; `draggingRef` names the nodes whose
  // position the local pointer currently owns.
  const clockRef = useRef(createClock())
  const syncRef = useRef({ epoch: null, seq: 0 })
  const pendingRef = useRef([])
  const draggingRef = useRef(new Set())

  // Canvas comments (Figma-style). commentMode flips the canvas into placement
  // mode (crosshair + click-to-comment); draft holds the pending new-comment
  // position in flow coords while its composer is open; openCommentId is the
  // thread whose popover is showing. The comment list + viewerIsOwner come from
  // useWorkflow; live mutations go through the merge helpers below.
  const [commentMode, setCommentMode] = useState(false)
  const [draft, setDraft] = useState(null)
  const [openCommentId, setOpenCommentId] = useState(null)

  // Merged elements arriving from the server (services/graphOps.js). The client
  // applies what the merge produced rather than re-deriving a winner from a
  // timestamp its own machine generated — which is the whole reason the server
  // holds the document.
  //
  // A node the local user is currently dragging is skipped: their pointer is
  // the freshest information anywhere, and a position echo mid-gesture would
  // yank the node under their cursor. It reconciles the moment they let go,
  // because drag end emits a final operation.
  const applyEffects = useCallback(
    (effects) => {
      for (const effect of effects || []) {
        if (effect.kind === 'node') {
          if (draggingRef.current.has(effect.id)) continue
          setNodes((nds) => applyEffect(nds, effect))
          // An edge cannot outlive its endpoints; the server drops those from
          // its document, and this keeps the canvas from rendering a connection
          // to nothing in the frame before the edge effects arrive.
          if (effect.element === null) {
            setEdges((eds) => eds.filter((e) => e.source !== effect.id && e.target !== effect.id))
          }
        } else {
          setEdges((eds) => applyEffect(eds, effect))
        }
      }
    },
    [setNodes, setEdges]
  )

  const handleGraphEffects = useCallback(
    ({ epoch, seq, lamport, effects }) => {
      observe(clockRef.current, lamport)
      syncRef.current = { epoch, seq }
      applyEffects(effects)
    },
    [applyEffects]
  )

  // The reply to a resync. A delta lists what changed since our marker; a
  // snapshot replaces the graph outright, which is what the server sends when
  // it cannot prove a delta would be sufficient.
  const handleGraphState = useCallback(
    ({ epoch, seq, lamport, changes, snapshot }) => {
      observe(clockRef.current, lamport)
      syncRef.current = { epoch, seq }
      if (snapshot) {
        setNodes((nds) => reconcileSnapshot(nds, snapshot.nodes))
        setEdges(snapshot.edges)
      } else {
        applyEffects(changes)
      }
    },
    [applyEffects, setNodes, setEdges]
  )

  // Our own operations came back refused: another site's edit won, and without
  // this we would be the only replica still showing the value we typed.
  const handleGraphAck = useCallback(
    ({ epoch, seq, lamport, corrections }) => {
      observe(clockRef.current, lamport)
      syncRef.current = { epoch, seq }
      applyEffects(corrections)
    },
    [applyEffects]
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
    onGraphEffects: handleGraphEffects,
    onGraphState: handleGraphState,
    onGraphAck: handleGraphAck,
    onResync: () => resync(),
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

  // Send a batch of operations, or queue it if the socket is down.
  //
  // Queueing rather than dropping is what makes a brief outage a delay instead
  // of lost work: the operations already carry the timestamps they were made
  // with, so replaying them on reconnect merges them at the position in the
  // order they actually occupy — not at the back, where a naive resend would
  // let them clobber edits made in the meantime.
  const sendOps = useCallback(
    (ops) => {
      if (ops.length === 0) return
      if (!socket.connected) {
        pendingRef.current.push(...ops)
        // Bounded: a tab left open on a dead connection for an hour must not
        // grow an unbounded queue. The oldest go first, and the resync that
        // follows reconnection repairs whatever they would have said.
        if (pendingRef.current.length > 2000) {
          pendingRef.current.splice(0, pendingRef.current.length - 2000)
        }
        return
      }
      socket.emit('graph-op', { workflowId, ops })
    },
    [socket, workflowId]
  )

  // Reconnected (or joined). Flush what was made offline, then ask for what was
  // missed. Order matters: sending first means the delta we get back already
  // accounts for our own edits, so we never see the server's pre-flush state
  // and then have to reconcile it away.
  const resync = useCallback(() => {
    const queued = pendingRef.current
    pendingRef.current = []
    if (queued.length > 0) socket.emit('graph-op', { workflowId, ops: queued })
    socket.emit('graph-sync', { workflowId, ...syncRef.current })
  }, [socket, workflowId])

  const emitNodeChange = useCallback(
    (action, node) => sendOps(nodeOps(clockRef.current, action, node)),
    [sendOps]
  )

  const emitEdgeChange = useCallback(
    (action, edge) => sendOps(edgeOps(clockRef.current, action, edge)),
    [sendOps]
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

  // `debug` (optional) carries the breakpoints this run should stop at. It is
  // sent with the run submission and nowhere else, which is what makes it
  // impossible for a schedule or a webhook to hit one.
  const handleRun = useCallback(async (debug = null) => {
    setIsTestRun(false)
    setActiveBreak(null)
    try {
      const { execution: ex } = await apiFetch(`/api/workflows/${workflowId}/execute`, {
        method: 'POST',
        ...(debug ? { body: { debug } } : {}),
      })
      executionIdRef.current = ex.id
      setExecSteps([])
      setPendingApprovals({})
      setPendingCallbacks({})
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
      setPendingApprovals({})
      setPendingCallbacks({})
      setExecution({ id: ex.id, status: ex.status, error: null })
    } catch (err) {
      executionIdRef.current = null
      setExecution({ id: null, status: 'failed', error: err.message })
      toastRef.current.error(`Couldn’t start test run: ${err.message}`)
    }
    setExecPanelOpen(true)
  }, [workflowId])

  // Settle a waiting approval gate. The run continues on its own — the
  // engine's poll sees the verdict and the step settling clears the controls
  // for everyone watching. A 409 just means someone else decided first.
  const handleRespondApproval = useCallback(async (approvalId, decision) => {
    try {
      const { progress } = await apiFetch(`/api/approvals/${approvalId}/respond`, {
        method: 'POST',
        body: { decision },
      })
      // A gate with a quorum may not settle on this response. Saying "run
      // continuing" then would be wrong, and it would be wrong in the
      // direction four-eyes exists to prevent — so the count is echoed back
      // instead, and the controls stay up for the next person.
      if (progress && progress.settled === false) {
        setPendingApprovals((prev) => {
          const entry = Object.entries(prev).find(([, a]) => a.id === approvalId)
          if (!entry) return prev
          return { ...prev, [entry[0]]: { ...entry[1], approvals: progress.approvals } }
        })
        toastRef.current.success(
          `Recorded — ${progress.approvals} of ${progress.needed} approvals.`
        )
        return
      }
      toastRef.current.success(decision === 'approve' ? 'Approved — run continuing.' : 'Rejected.')
    } catch (err) {
      toastRef.current.error(`Couldn’t record the decision: ${err.message}`)
    }
  }, [])

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
  const runDeploy = useCallback(async () => {
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

  // Deploying is the moment a broken contract starts costing somebody else:
  // the version other workflows resolve against changes, and the runs that go
  // wrong afterwards belong to people who did not make this edit and cannot see
  // this canvas. So the check happens here rather than as a banner somebody
  // scrolls past — and it is a confirmation rather than a refusal, because
  // sometimes the right answer is to deploy and go fix the callers.
  //
  // Best-effort by construction: if the check itself fails, the deploy proceeds.
  // A contract analysis that could block a deploy by being unavailable would be
  // a worse failure than the one it exists to prevent.
  const handleDeploy = useCallback(async () => {
    setDeploying(true)
    let report = null
    try {
      report = await apiFetch(`/api/workflows/${workflowId}/contract`, {
        method: 'POST',
        body: serializeGraph(nodes, edges),
      })
    } catch {
      /* the gate never blocks on its own failure */
    } finally {
      setDeploying(false)
    }
    if (report?.available && report.summary.broken > 0) {
      setContractGate(report)
      return
    }
    await runDeploy()
  }, [workflowId, nodes, edges, runDeploy])

  // Flip the kill switch. Idempotent server-side, so a stale UI can't wedge;
  // the toast names the resulting state. On success the hook has already folded
  // the fresh paused_at into `workflow`, so the banner and toolbar re-render.
  const handleTogglePause = useCallback(async () => {
    const next = !paused
    setPausing(true)
    try {
      await setPaused(next)
      toastRef.current.success(
        next
          ? 'Workflow paused — new runs are held until you resume it.'
          : 'Workflow resumed — new runs are accepted again.'
      )
    } catch (err) {
      toastRef.current.error(
        `Couldn’t ${next ? 'pause' : 'resume'} the workflow: ${err.message}`
      )
    } finally {
      setPausing(false)
    }
  }, [paused, setPaused])

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
  const handleToggleLineage = useCallback(() => setLineageOpen((v) => !v), [])
  const handleToggleConvergence = useCallback(() => setConvergenceOpen((v) => !v), [])
  const handleToggleGuarantees = useCallback(() => setGuaranteesOpen((v) => !v), [])
  const handleTogglePaths = useCallback(() => setPathsOpen((v) => !v), [])
  const handleTogglePreview = useCallback(() => setPreviewOpen((v) => !v), [])
  const handleToggleDebugger = useCallback(() => setDebuggerOpen((v) => !v), [])
  const handleToggleFlowText = useCallback(() => setFlowTextOpen((v) => !v), [])

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

  // Condition-branch edges get a true/false label for rendering only — the
  // `edges` state (what auto-save persists and collaboration broadcasts)
  // stays undecorated.
  // Then the converging edges whose value does not survive the merge, drawn
  // dashed and labelled with what they lose — the one place that ordering has
  // ever been visible. Only while the Convergence panel is open, since it is
  // the panel's report that says which they are.
  const displayEdges = useMemo(
    () => decorateCollidingEdges(decorateConditionEdges(edges), convergence),
    [edges, convergence]
  )

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
            // While a drag is in flight the local pointer owns this node's
            // position, so incoming effects for it are ignored (see
            // applyEffects) rather than yanking it out from under the cursor.
            draggingRef.current.add(change.id)
            dragEmitRef.current[change.id] = now
            emitNodeChange('update', { id: change.id, position: change.position })
          } else if (!change.dragging) {
            // drag end — always send the final position, then hand the node
            // back to the merge.
            draggingRef.current.delete(change.id)
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
        onToggleRunSettings={() => setRunSettingsOpen((v) => !v)}
        onToggleBackfill={() => setBackfillOpen((v) => !v)}
        backfillOpen={backfillOpen}
        onToggleInsights={() => setInsightsOpen((v) => !v)}
        insightsOpen={insightsOpen}
        onToggleCanary={() => setCanaryOpen((v) => !v)}
        canaryOpen={canaryOpen}
        onToggleTests={() => setTestsOpen((v) => !v)}
        testsOpen={testsOpen}
        onToggleCommentMode={toggleCommentMode}
        commentMode={commentMode}
        onAutoLayout={handleAutoLayout}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onToggleIssues={handleToggleIssues}
        issuesOpen={issuesOpen}
        onToggleLineage={handleToggleLineage}
        lineageOpen={lineageOpen}
        onToggleConvergence={handleToggleConvergence}
        convergenceOpen={convergenceOpen}
        onToggleGuarantees={handleToggleGuarantees}
        guaranteesOpen={guaranteesOpen}
        onTogglePaths={handleTogglePaths}
        pathsOpen={pathsOpen}
        onTogglePreview={handleTogglePreview}
        previewOpen={previewOpen}
        onToggleDebugger={handleToggleDebugger}
        debuggerOpen={debuggerOpen}
        onToggleFlowText={handleToggleFlowText}
        flowTextOpen={flowTextOpen}
        onDeploy={handleDeploy}
        onToggleHistory={handleToggleHistory}
        onOpenMerge={() => setMergeOpen(true)}
        onTogglePause={handleTogglePause}
        paused={paused}
        pausing={pausing}
        running={execution?.status === 'running' || execution?.status === 'pending'}
        testing={testBannerVisible}
        suggesting={suggestLoading}
        generating={generating}
        deploying={deploying}
        scheduleWarning={hasSchedule && !deployed}
      />
      <PresenceBar users={remoteUsers} selfId={user?.id} />
      {paused && (
        <div className="canvas-pause-banner" role="status">
          ⏸ This workflow is paused — new runs are held (manual, API, webhook,
          and schedule). Test runs still work. Resume from the toolbar to accept
          runs again.
        </div>
      )}
      {testBannerVisible && (
        <div className="canvas-test-banner" role="status">
          ⚡ Test mode — action nodes will not fire
        </div>
      )}
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
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
      <RunSettingsPanel
        workflowId={workflowId}
        open={runSettingsOpen}
        onClose={() => setRunSettingsOpen(false)}
      />
      <BackfillPanel
        workflowId={workflowId}
        open={backfillOpen}
        onClose={() => setBackfillOpen(false)}
      />
      <InsightsPanel
        workflowId={workflowId}
        open={insightsOpen}
        onClose={() => setInsightsOpen(false)}
        nodes={nodes}
      />
      <CanaryPanel
        workflowId={workflowId}
        open={canaryOpen}
        onClose={() => setCanaryOpen(false)}
      />
      <TestsPanel
        workflowId={workflowId}
        open={testsOpen}
        onClose={() => setTestsOpen(false)}
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
      {/* Anchored on the same side as Issues: both answer "what's wrong with
          this graph?" and neither should fight the config panel on the right. */}
      {lineageOpen && (
        <LineagePanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedNode?.id || null}
          onClose={() => setLineageOpen(false)}
          onSelectNode={handleSelectIssueNode}
        />
      )}
      {contractGate && (
        <ContractGate
          report={contractGate}
          onCancel={() => setContractGate(null)}
          onConfirm={() => {
            setContractGate(null)
            runDeploy()
          }}
        />
      )}
      {/* Sixth on the same side, and the only one whose answer the *canvas*
          draws: while it is open, every converging edge whose value does not
          survive the merge is dashed and labelled with what it loses. That
          ordering was always determined and has never been visible. */}
      {convergenceOpen && (
        <ConvergencePanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          onClose={() => setConvergenceOpen(false)}
          onSelectNode={handleSelectIssueNode}
          onReport={setConvergence}
        />
      )}
      {/* Opens itself when a run stops, because a paused run is not going
          anywhere until somebody acts and hiding that would look like a hang. */}
      {debuggerOpen && (
        <DebuggerPanel
          nodes={nodes}
          executionId={execution?.id || null}
          activeBreak={activeBreak}
          onClose={() => setDebuggerOpen(false)}
          onSelectNode={handleSelectIssueNode}
          onStartDebugRun={(debug) => handleRun(debug)}
          onResumed={() => setActiveBreak(null)}
        />
      )}
      {/* Same side again, and for the same reason: this is the third answer to
          "what's wrong with this graph?" — the linter's is about the nodes, the
          lineage's is about the data, and this one is about the paths. */}
      {guaranteesOpen && (
        <GuaranteesPanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          onClose={() => setGuaranteesOpen(false)}
          onSelectNode={handleSelectIssueNode}
        />
      )}
      {/* The canvas is for drawing; this is for surgery. Applying goes through
          the server and the canvas reloads the result — the same shape as a
          merge or a restore, so the collaboration layer sees one external
          change rather than a storm of synthetic edits. */}
      {flowTextOpen && (
        <FlowTextPanel
          workflowId={workflowId}
          open={flowTextOpen}
          onClose={() => setFlowTextOpen(false)}
          onApplied={(updated) => {
            applyWorkflow(updated)
            toastRef.current.success('Workflow updated from text.')
          }}
        />
      )}
      {/* And the fourth, which is the only one that reasons about the *data*:
          the linter's answer is about the nodes, lineage's about where values
          come from, guarantees' about the paths the graph admits, and this
          one's about which of those paths any input can actually take. */}
      {pathsOpen && (
        <PathsPanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          onClose={() => setPathsOpen(false)}
          onSelectNode={handleSelectIssueNode}
          onToast={toast}
        />
      )}
      {/* The fifth, and the only one that is not a pure function of the graph:
          it replays real runs, which is why it has a button instead of a
          debounce. Same side as the others — it answers "what is wrong with
          this graph?" in the sharpest form there is, which is "here is what it
          would have done differently". */}
      {previewOpen && (
        <PreviewPanel
          workflowId={workflowId}
          nodes={nodes}
          edges={edges}
          onClose={() => setPreviewOpen(false)}
          onSelectNode={handleSelectIssueNode}
        />
      )}
      {/* A merge rewrites the live graph server-side, so the canvas reloads it
          rather than trying to reconcile a second time on the client. */}
      {mergeOpen && (
        <MergeModal
          workflowId={workflowId}
          onClose={() => setMergeOpen(false)}
          onMerged={async () => {
            try {
              const { workflow } = await apiFetch(`/api/workflows/${workflowId}`)
              applyWorkflow(workflow)
            } catch {
              /* the merge landed server-side; a failed reload is a refresh away */
            }
          }}
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
        pendingApprovals={pendingApprovals}
        pendingCallbacks={pendingCallbacks}
        onRespondApproval={handleRespondApproval}
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
