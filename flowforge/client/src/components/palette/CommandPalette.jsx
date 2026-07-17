import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'
import { fuzzyFilter, highlightSegments } from '../../utils/fuzzy'

// Global command palette (Ctrl/⌘-K): fuzzy-jump to any workflow across every
// workspace, open a workspace's pages, or create a workflow — all without
// touching the mouse. Items load fresh each time the palette opens so it never
// shows stale workflows; the palette renders nothing while closed.
//
// Two result tiers: instant client-side fuzzy over names/pages, and — once
// the query is 2+ chars — debounced server-side full-text results
// (GET /api/search) that match what's *inside* workflows: node labels,
// config strings, sticky notes. "Which workflow calls stripe?" is answerable
// from the palette.

const MAX_RESULTS = 12
const DEEP_SEARCH_MIN_CHARS = 2
const DEEP_SEARCH_DEBOUNCE_MS = 200

function Highlighted({ text, indices }) {
  return highlightSegments(text, indices).map((seg, i) =>
    seg.match ? (
      <mark key={i} className="palette__mark">{seg.text}</mark>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  )
}

// Server search snippets mark matches as [term]; render the brackets as the
// same <mark> the fuzzy tier uses.
function SnippetHighlighted({ snippet }) {
  return String(snippet)
    .split(/\[([^\]]*)\]/)
    .map((part, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="palette__mark">{part}</mark>
      ) : (
        <span key={i}>{part}</span>
      )
    )
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState(null) // null = loading
  const [deepResults, setDeepResults] = useState([]) // server full-text hits
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

  // Deep (server) search, debounced. Failures just leave the fuzzy tier —
  // the palette must stay useful when the search endpoint hiccups.
  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < DEEP_SEARCH_MIN_CHARS) {
      setDeepResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      apiFetch(`/api/search?q=${encodeURIComponent(q)}&limit=6`)
        .then(({ results: found }) => {
          if (!cancelled) setDeepResults(found || [])
        })
        .catch(() => {
          if (!cancelled) setDeepResults([])
        })
    }, DEEP_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  const results = useMemo(
    () => fuzzyFilter(query, items || [], (item) => item.keywords).slice(0, MAX_RESULTS),
    [query, items]
  )

  // One flat, arrow-navigable list: fuzzy hits first, then deep hits for
  // workflows the fuzzy tier didn't already surface by name.
  const rows = useMemo(() => {
    const shown = new Set(results.map(({ item }) => item.key))
    const deep = deepResults
      .filter((r) => !shown.has(`wf:${r.workflowId}`))
      .map((r) => ({
        indices: [],
        item: {
          key: `deep:${r.workflowId}`,
          icon: '🔎',
          title: r.name,
          snippet: r.snippet,
          field: r.field,
          run: () => navigate(`/workflow/${r.workflowId}`),
        },
      }))
    return [...results, ...deep]
    // navigate is stable (react-router memoizes it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, deepResults])

  // Clamp the selection whenever the result set shrinks.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(rows.length - 1, 0)))
  }, [rows.length])

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
      setSelected((s) => Math.min(s + 1, rows.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (rows[selected]) runItem(rows[selected].item)
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
        ) : rows.length === 0 ? (
          <p className="palette__status">No matches for “{query}”.</p>
        ) : (
          <ul className="palette__list" ref={listRef} role="listbox">
            {rows.map(({ item, indices }, i) => {
              // indices refer to item.keywords; the title is its prefix, so
              // only positions inside the title highlight.
              const titleIndices = indices.filter((idx) => idx < item.title.length)
              const isDeep = item.key.startsWith('deep:')
              const firstDeep = isDeep && (i === 0 || !rows[i - 1].item.key.startsWith('deep:'))
              return (
                <li key={item.key}>
                  {firstDeep && (
                    <div className="palette__section" aria-hidden="true">
                      Found inside workflows
                    </div>
                  )}
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
                    <span className={`palette__detail${isDeep ? ' palette__detail--snippet' : ''}`}>
                      {isDeep ? <SnippetHighlighted snippet={item.snippet} /> : item.detail}
                    </span>
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
