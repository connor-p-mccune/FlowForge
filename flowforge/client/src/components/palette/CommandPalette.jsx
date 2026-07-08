import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { fuzzyFilter, highlightSegments } from '../../utils/fuzzy'

// Global command palette (Ctrl/⌘-K): fuzzy-jump to any workflow across every
// workspace, open a workspace's pages, or create a workflow — all without
// touching the mouse. Items load fresh each time the palette opens so it never
// shows stale workflows; the palette renders nothing while closed.

const MAX_RESULTS = 12

function Highlighted({ text, indices }) {
  return highlightSegments(text, indices).map((seg, i) =>
    seg.match ? (
      <mark key={i} className="palette__mark">{seg.text}</mark>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  )
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState(null) // null = loading
  const [selected, setSelected] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Load fresh palette entries whenever it opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setItems(null)
    setQuery('')
    setSelected(0)

    async function load() {
      try {
        const { workspaces } = await apiFetch('/api/workspaces')
        const workflowLists = await Promise.all(
          workspaces.map((ws) =>
            apiFetch(`/api/workspaces/${ws.id}/workflows`)
              .then(({ workflows }) => workflows.map((wf) => ({ wf, ws })))
              .catch(() => [])
          )
        )
        if (cancelled) return

        const entries = []
        for (const { wf, ws } of workflowLists.flat()) {
          entries.push({
            key: `wf:${wf.id}`,
            icon: '⚡',
            title: wf.name,
            detail: ws.name,
            keywords: `${wf.name} ${ws.name}`,
            run: () => navigate(`/workflow/${wf.id}`),
          })
        }
        entries.push({
          key: 'page:dashboard',
          icon: '🏠',
          title: 'Dashboard',
          detail: 'page',
          keywords: 'dashboard home',
          run: () => navigate('/'),
        })
        entries.push({
          key: 'page:settings',
          icon: '⚙️',
          title: 'Settings',
          detail: 'page',
          keywords: 'settings account security tokens',
          run: () => navigate('/settings'),
        })
        for (const ws of workspaces) {
          entries.push(
            {
              key: `analytics:${ws.id}`,
              icon: '📊',
              title: `Analytics — ${ws.name}`,
              detail: 'page',
              keywords: `analytics ${ws.name}`,
              run: () => navigate(`/workspace/${ws.id}/analytics`),
            },
            {
              key: `activity:${ws.id}`,
              icon: '📜',
              title: `Activity — ${ws.name}`,
              detail: 'page',
              keywords: `activity feed ${ws.name}`,
              run: () => navigate(`/workspace/${ws.id}/activity`),
            },
            {
              key: `secrets:${ws.id}`,
              icon: '🔑',
              title: `Secrets — ${ws.name}`,
              detail: 'page',
              keywords: `secrets keys ${ws.name}`,
              run: () => navigate(`/workspace/${ws.id}/secrets`),
            },
            {
              key: `new:${ws.id}`,
              icon: '＋',
              title: `New workflow — ${ws.name}`,
              detail: 'action',
              keywords: `new create workflow ${ws.name}`,
              run: async () => {
                const { workflow } = await apiFetch(`/api/workspaces/${ws.id}/workflows`, {
                  method: 'POST',
                  body: { name: 'Untitled workflow' },
                })
                navigate(`/workflow/${workflow.id}`)
              },
            }
          )
        }
        setItems(entries)
      } catch (err) {
        if (!cancelled) {
          setItems([])
          toast.error(`Couldn’t load search results: ${err.message}`)
        }
      }
    }
    load()
    return () => { cancelled = true }
    // toast is stable enough (context helper); re-running on open is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, navigate])

  // Focus the input as soon as the palette mounts open.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open, items])

  const results = useMemo(
    () => fuzzyFilter(query, items || [], (item) => item.keywords).slice(0, MAX_RESULTS),
    [query, items]
  )

  // Clamp the selection whenever the result set shrinks.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(results.length - 1, 0)))
  }, [results.length])

  const runItem = useCallback(
    async (entry) => {
      onClose()
      try {
        await entry.run()
      } catch (err) {
        toast.error(err.message)
      }
    },
    [onClose, toast]
  )

  function handleKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (results[selected]) runItem(results[selected].item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Keep the selected row visible while arrowing through results.
  useEffect(() => {
    // scrollIntoView is missing in jsdom — optional call keeps tests happy.
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  if (!open) return null

  return (
    <div className="palette__backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette__input"
          placeholder="Jump to a workflow, open a page, create…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Search"
        />
        {items === null ? (
          <p className="palette__status">Loading…</p>
        ) : results.length === 0 ? (
          <p className="palette__status">No matches for “{query}”.</p>
        ) : (
          <ul className="palette__list" ref={listRef} role="listbox">
            {results.map(({ item, indices }, i) => {
              // indices refer to item.keywords; the title is its prefix, so
              // only positions inside the title highlight.
              const titleIndices = indices.filter((idx) => idx < item.title.length)
              return (
                <li key={item.key}>
                  <button
                    className={`palette__item${i === selected ? ' palette__item--selected' : ''}`}
                    role="option"
                    aria-selected={i === selected}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => runItem(item)}
                  >
                    <span className="palette__icon" aria-hidden="true">{item.icon}</span>
                    <span className="palette__title">
                      <Highlighted text={item.title} indices={titleIndices} />
                    </span>
                    <span className="palette__detail">{item.detail}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div className="palette__footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
