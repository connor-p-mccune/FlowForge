import { useState, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import { NODE_DEFS } from '../canvas/nodeDefs'

// Filter order across the top of the gallery. Matches the seeded categories;
// "All" is the default view.
const CATEGORIES = ['All', 'AI Automation', 'Reporting', 'Notifications', 'Data Processing', 'Resilience']

// Map a node type to the colour family used for nodes/toolbar buttons, so the
// gallery's chips/badges read the same as the canvas.
function nodeColor(type) {
  if (type.startsWith('trigger-')) return 'trigger'
  if (type.startsWith('ai-')) return 'ai'
  if (type === 'condition') return 'condition'
  if (type.startsWith('output-')) return 'output'
  return 'action' // action-* and transform
}

// Human-friendly name for a node type, reusing the canvas's own definitions.
function typeLabel(type) {
  return NODE_DEFS[type]?.label || type
}

// Full-screen modal: search + filter the built-in templates, preview one, and
// clone it into the active workspace.
export default function TemplateGallery({ workspaceId, onClose, onCreated }) {
  const navigate = useNavigate()

  const [grouped, setGrouped] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')
  const [selectedId, setSelectedId] = useState(null)
  const [using, setUsing] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch('/api/templates')
      .then(({ templates }) => {
        if (!cancelled) setGrouped(templates || {})
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  // Close on Escape.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const all = useMemo(() => Object.values(grouped).flat(), [grouped])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((t) => {
      const matchesCat = category === 'All' || t.category === category
      const matchesQuery =
        !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
      return matchesCat && matchesQuery
    })
  }, [all, query, category])

  // Keep a valid selection: pick the first match whenever the current one drops
  // out of the filtered list (and on first load).
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null)
    } else if (!filtered.some((t) => t.id === selectedId)) {
      setSelectedId(filtered[0].id)
    }
  }, [filtered, selectedId])

  const selected = useMemo(
    () => all.find((t) => t.id === selectedId) || null,
    [all, selectedId]
  )

  const handleUse = useCallback(async () => {
    if (!selected || !workspaceId) return
    setUsing(true)
    setError(null)
    try {
      const { workflow } = await apiFetch(
        `/api/workspaces/${workspaceId}/workflows/from-template`,
        { method: 'POST', body: { templateId: selected.id, name: selected.name } }
      )
      onCreated?.(workflow)
      onClose()
      navigate(`/workflow/${workflow.id}`)
    } catch (err) {
      setError(err.message)
      setUsing(false)
    }
  }, [selected, workspaceId, onCreated, onClose, navigate])

  // Portal to <body> so the full-screen overlay escapes the sidebar's stacking
  // context (the sidebar gets a CSS transform on narrow screens, which would
  // otherwise trap a position:fixed child).
  return createPortal(
    <div
      className="tmpl-gallery"
      role="dialog"
      aria-modal="true"
      aria-label="Workflow template gallery"
      onClick={onClose}
    >
      {/* Stop backdrop clicks inside the modal from closing it. */}
      <div className="tmpl-gallery__modal" onClick={(e) => e.stopPropagation()}>
        <header className="tmpl-gallery__header">
          <h2 className="tmpl-gallery__title">Start from a template</h2>
          <input
            className="tmpl-gallery__search"
            type="search"
            placeholder="Search templates…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button className="tmpl-gallery__close" title="Close" onClick={onClose}>×</button>
        </header>

        <div className="tmpl-gallery__filters">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`tmpl-filter${category === cat ? ' tmpl-filter--active' : ''}`}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="tmpl-gallery__body">
          <div className="tmpl-gallery__list">
            {loading ? (
              <p className="tmpl-gallery__hint">Loading templates…</p>
            ) : error && all.length === 0 ? (
              <p className="tmpl-gallery__error">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="tmpl-gallery__hint">No templates match your search.</p>
            ) : (
              <div className="tmpl-grid">
                {filtered.map((t) => (
                  <button
                    key={t.id}
                    className={`tmpl-card${t.id === selectedId ? ' tmpl-card--selected' : ''}`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <div className="tmpl-card__top">
                      <span className="tmpl-card__name">{t.name}</span>
                      <span className="tmpl-badge">{t.category}</span>
                    </div>
                    <p className="tmpl-card__desc">{t.description}</p>
                    <div className="tmpl-card__chips">
                      {t.graph.nodes.map((node, i) => (
                        <span key={node.id} className="tmpl-card__chip-wrap">
                          {i > 0 && <span className="tmpl-card__arrow">→</span>}
                          <span className={`tmpl-chip tmpl-chip--${nodeColor(node.type)}`}>
                            {node.data?.label || typeLabel(node.type)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <aside className="tmpl-gallery__preview">
            {selected ? (
              <TemplatePreview
                template={selected}
                onUse={handleUse}
                using={using}
                error={error}
              />
            ) : (
              !loading && <p className="tmpl-gallery__hint">Select a template to preview it.</p>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body
  )
}

// Right-hand detail panel: the full node list and the edges described in text.
function TemplatePreview({ template, onUse, using, error }) {
  const { nodes, edges } = template.graph
  const labelOf = (id) => nodes.find((n) => n.id === id)?.data?.label || id

  return (
    <div className="tmpl-preview">
      <div className="tmpl-preview__head">
        <h3 className="tmpl-preview__name">{template.name}</h3>
        <span className="tmpl-badge">{template.category}</span>
      </div>
      <p className="tmpl-preview__desc">{template.description}</p>

      <h4 className="tmpl-preview__section">Steps</h4>
      <ol className="tmpl-preview__nodes">
        {nodes.map((node) => (
          <li key={node.id} className="tmpl-preview__node">
            <span className={`tmpl-dot tmpl-dot--${nodeColor(node.type)}`} aria-hidden="true" />
            <span className="tmpl-preview__node-label">{node.data?.label || typeLabel(node.type)}</span>
            <span className="tmpl-preview__node-type">{typeLabel(node.type)}</span>
          </li>
        ))}
      </ol>

      <h4 className="tmpl-preview__section">Connections</h4>
      <ul className="tmpl-preview__edges">
        {edges.map((edge) => (
          <li key={edge.id} className="tmpl-preview__edge">
            <span className="tmpl-preview__edge-from">{labelOf(edge.source)}</span>
            <span className="tmpl-preview__edge-arrow">
              →{edge.sourceHandle ? ` (${edge.sourceHandle})` : ''}
            </span>
            <span className="tmpl-preview__edge-to">{labelOf(edge.target)}</span>
          </li>
        ))}
      </ul>

      {error && <p className="tmpl-gallery__error">{error}</p>}

      <button className="tmpl-preview__use" onClick={onUse} disabled={using}>
        {using ? 'Creating…' : 'Use Template'}
      </button>
    </div>
  )
}
