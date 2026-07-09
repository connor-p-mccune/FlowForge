import { useCallback, useEffect, useRef, useState } from 'react'
import { serializeGraph } from './useWorkflow'

const MAX_HISTORY = 50
// Rapid-fire changes (a drag emits dozens of position updates) collapse into
// one history entry if they land within this window.
const COMMIT_DEBOUNCE_MS = 400

// Snapshot-based undo/redo for the canvas. History entries are serialized
// { nodes, edges } graphs (volatile props stripped), so a step is "the canvas
// as it looked", not a keystroke. Applying a step diffs the target against the
// live graph and broadcasts every difference over the existing collaboration
// channel — collaborators converge on the undone state instead of forking.
//
// Remote edits land in `nodes`/`edges` like local ones and therefore become
// part of local history; undoing past them reverts them here and (via the
// broadcast) everywhere. That is the standard last-write-wins trade-off this
// canvas already makes.
export function useUndoRedo({
  ready,
  nodes,
  edges,
  setNodes,
  setEdges,
  emitNodeChange,
  emitEdgeChange,
}) {
  const past = useRef([])
  const future = useRef([])
  const present = useRef(null) // last committed snapshot (JSON string)
  const applying = useRef(false) // the next graph change is our own apply
  const timer = useRef(null)
  const latest = useRef(null) // snapshot of the graph as of this render
  // Bumped whenever the stacks change so canUndo/canRedo re-render consumers.
  const [, setVersion] = useState(0)
  const bump = () => setVersion((v) => v + 1)

  latest.current = JSON.stringify(serializeGraph(nodes, edges))

  // Keep the live graph in refs so undo/redo callbacks are stable.
  const graphRef = useRef({ nodes, edges })
  graphRef.current = { nodes, edges }

  // Commit the pending debounce window (if any) into history immediately.
  const flush = useCallback(() => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = null
    if (latest.current !== present.current) {
      past.current.push(present.current)
      if (past.current.length > MAX_HISTORY) past.current.shift()
      present.current = latest.current
      future.current = []
    }
  }, [])

  useEffect(() => {
    if (!ready) {
      // Workflow switching/loading: drop history so undo can't cross documents
      // (or "undo" the initial load into an empty canvas).
      past.current = []
      future.current = []
      present.current = null
      applying.current = false
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      return
    }
    const snap = latest.current
    if (present.current === null) {
      present.current = snap // baseline: the freshly loaded graph
      return
    }
    if (applying.current) {
      // Our own undo/redo landing — stacks were already adjusted.
      applying.current = false
      return
    }
    if (snap === present.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      past.current.push(present.current)
      if (past.current.length > MAX_HISTORY) past.current.shift()
      present.current = latest.current
      future.current = []
      bump()
    }, COMMIT_DEBOUNCE_MS)
  }, [ready, nodes, edges])

  // Swap the canvas to `target` and broadcast the differences so peers follow.
  const applySnapshot = useCallback(
    (targetJson) => {
      const target = JSON.parse(targetJson)
      const current = serializeGraph(graphRef.current.nodes, graphRef.current.edges)

      const currentNodes = new Map(current.nodes.map((n) => [n.id, n]))
      const targetNodes = new Map(target.nodes.map((n) => [n.id, n]))
      for (const [id] of currentNodes) {
        if (!targetNodes.has(id)) emitNodeChange('remove', { id })
      }
      for (const [id, node] of targetNodes) {
        const before = currentNodes.get(id)
        if (!before) {
          emitNodeChange('add', node)
        } else if (JSON.stringify(before) !== JSON.stringify(node)) {
          emitNodeChange('update', { id, position: node.position, data: node.data })
        }
      }

      const currentEdges = new Map(current.edges.map((e) => [e.id, e]))
      const targetEdges = new Map(target.edges.map((e) => [e.id, e]))
      for (const [id] of currentEdges) {
        if (!targetEdges.has(id)) emitEdgeChange('remove', { id })
      }
      for (const [id, edge] of targetEdges) {
        if (!currentEdges.has(id)) emitEdgeChange('add', edge)
      }

      applying.current = true
      setNodes(target.nodes)
      setEdges(target.edges)
    },
    [setNodes, setEdges, emitNodeChange, emitEdgeChange]
  )

  const undo = useCallback(() => {
    flush()
    if (past.current.length === 0) return
    const target = past.current.pop()
    future.current.push(present.current)
    present.current = target
    applySnapshot(target)
    bump()
  }, [flush, applySnapshot])

  const redo = useCallback(() => {
    flush()
    if (future.current.length === 0) return
    const target = future.current.pop()
    past.current.push(present.current)
    present.current = target
    applySnapshot(target)
    bump()
  }, [flush, applySnapshot])

  return {
    undo,
    redo,
    canUndo: past.current.length > 0 || (timer.current !== null && latest.current !== present.current),
    canRedo: future.current.length > 0,
  }
}
