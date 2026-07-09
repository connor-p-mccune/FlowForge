import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoRedo } from '../hooks/useUndoRedo'

const node = (id, x = 0) => ({
  id,
  type: 'output-log',
  position: { x, y: 0 },
  data: { label: id, config: {} },
})

// Drives the hook the way the canvas does: state lives out here, setNodes /
// setEdges mutate it, and rerender() feeds it back in.
function setup(initialNodes = [node('a')]) {
  let state = { nodes: initialNodes, edges: [] }
  const emitNodeChange = vi.fn()
  const emitEdgeChange = vi.fn()
  const setNodes = vi.fn((next) => {
    state = { ...state, nodes: typeof next === 'function' ? next(state.nodes) : next }
  })
  const setEdges = vi.fn((next) => {
    state = { ...state, edges: typeof next === 'function' ? next(state.edges) : next }
  })

  const view = renderHook(
    ({ ready }) =>
      useUndoRedo({
        ready,
        nodes: state.nodes,
        edges: state.edges,
        setNodes,
        setEdges,
        emitNodeChange,
        emitEdgeChange,
      }),
    { initialProps: { ready: true } }
  )

  const applyChange = (nodes, edges = state.edges) => {
    state = { nodes, edges }
    view.rerender({ ready: true })
    act(() => {
      vi.advanceTimersByTime(500) // commit the debounce window
    })
    view.rerender({ ready: true })
  }

  return { view, applyChange, getState: () => state, emitNodeChange, emitEdgeChange }
}

describe('useUndoRedo', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('undoes to the previous snapshot and broadcasts the differences', () => {
    const { view, applyChange, getState, emitNodeChange } = setup()

    applyChange([node('a'), node('b')]) // add b
    expect(view.result.current.canUndo).toBe(true)

    act(() => view.result.current.undo())
    // The canvas is back to just `a`, and peers were told to drop `b`.
    expect(getState().nodes.map((n) => n.id)).toEqual(['a'])
    expect(emitNodeChange).toHaveBeenCalledWith('remove', { id: 'b' })
  })

  it('redoes an undone step and broadcasts the re-add', () => {
    const { view, applyChange, getState, emitNodeChange } = setup()
    applyChange([node('a'), node('b')])

    act(() => view.result.current.undo())
    view.rerender({ ready: true })
    expect(view.result.current.canRedo).toBe(true)

    emitNodeChange.mockClear()
    act(() => view.result.current.redo())
    expect(getState().nodes.map((n) => n.id).sort()).toEqual(['a', 'b'])
    expect(emitNodeChange).toHaveBeenCalledWith(
      'add',
      expect.objectContaining({ id: 'b' })
    )
  })

  it('broadcasts position/data updates for nodes that changed between snapshots', () => {
    const { view, applyChange, emitNodeChange } = setup([node('a', 0)])
    applyChange([node('a', 250)]) // moved

    act(() => view.result.current.undo())
    expect(emitNodeChange).toHaveBeenCalledWith(
      'update',
      expect.objectContaining({ id: 'a', position: { x: 0, y: 0 } })
    )
  })

  it('a new edit clears the redo stack', () => {
    const { view, applyChange } = setup()
    applyChange([node('a'), node('b')])
    act(() => view.result.current.undo())
    view.rerender({ ready: true })
    expect(view.result.current.canRedo).toBe(true)

    applyChange([node('a'), node('c')]) // diverge
    expect(view.result.current.canRedo).toBe(false)
  })

  it('collapses rapid changes inside the debounce window into one step', () => {
    const { view, applyChange, getState } = setup()

    // A fast intermediate change (mid-drag frame) that never gets to commit…
    view.rerender({ ready: true })
    // …followed within the window by the final state, which does.
    applyChange([node('a'), node('b'), node('c')])

    act(() => view.result.current.undo())
    // One undo returns to the baseline, not to an intermediate frame.
    expect(getState().nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('does not record while not ready, and resets history on reload', () => {
    const { view, applyChange } = setup()
    applyChange([node('a'), node('b')])
    expect(view.result.current.canUndo).toBe(true)

    view.rerender({ ready: false }) // workflow switching
    view.rerender({ ready: true })
    expect(view.result.current.canUndo).toBe(false)
  })
})
