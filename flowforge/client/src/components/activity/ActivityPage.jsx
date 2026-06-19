import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../../services/api'
import { SkeletonRows } from '../Skeleton'
import { useWorkspaceActivity } from '../../hooks/useWorkspaceActivity'
import ActivityEvent from './ActivityEvent'
import { CATEGORIES } from './format'

const PAGE_SIZE = 50

// Build the feed URL for a page. `before` is the created_at cursor of the last row
// you already have; omit it for page 1.
function activityUrl(workspaceId, category, before) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (category && category !== 'all') params.set('category', category)
  if (before) params.set('before', before)
  return `/api/workspaces/${workspaceId}/activity?${params.toString()}`
}

export default function ActivityPage({ workspaceId }) {
  const [category, setCategory] = useState('all')
  const [events, setEvents] = useState([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)

  // The live socket handler needs the current filter without re-subscribing.
  const categoryRef = useRef(category)
  categoryRef.current = category

  // Initial load, and reload whenever the workspace or active filter changes.
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const data = await apiFetch(activityUrl(workspaceId, category))
        if (cancelled) return
        setEvents(data.activity)
        setHasMore(data.hasMore)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId, category])

  async function loadMore() {
    if (loadingMore || events.length === 0) return
    setLoadingMore(true)
    try {
      const before = events[events.length - 1].created_at
      const data = await apiFetch(activityUrl(workspaceId, category, before))
      // Dedupe defensively in case a live event raced in at the page boundary.
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id))
        return [...prev, ...data.activity.filter((e) => !seen.has(e.id))]
      })
      setHasMore(data.hasMore)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  // Live updates: prepend a new event if it matches the active filter and isn't
  // already shown. The room carries every category, so filter client-side.
  const onEvent = useCallback((event) => {
    const cat = CATEGORIES.find((c) => c.key === categoryRef.current)
    if (cat && cat.prefix && !String(event.event_type).startsWith(cat.prefix)) return
    setEvents((prev) =>
      prev.some((e) => e.id === event.id) ? prev : [{ ...event, __isNew: true }, ...prev]
    )
  }, [])

  // After a reconnect, refetch page 1 to catch anything missed while offline.
  const onReconnect = useCallback(() => {
    apiFetch(activityUrl(workspaceId, categoryRef.current))
      .then((data) => { setEvents(data.activity); setHasMore(data.hasMore) })
      .catch(() => {})
  }, [workspaceId])

  useWorkspaceActivity(workspaceId, { onEvent, onReconnect })

  return (
    <div className="activity">
      <div className="activity__header">
        <h1 className="activity__title">Activity</h1>
        <div className="activity__filters" role="group" aria-label="Filter activity">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`activity__filter-btn${category === c.key ? ' activity__filter-btn--active' : ''}`}
              onClick={() => setCategory(c.key)}
              disabled={loading}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="activity__error">Unable to load activity — {error}</div>
      ) : loading ? (
        <div className="activity__loading">
          <SkeletonRows count={8} height={56} />
        </div>
      ) : events.length === 0 ? (
        <div className="activity__empty">
          <div className="activity__empty-title">No activity yet</div>
          <p className="activity__empty-hint">
            Actions in this workspace — deploys, runs, members — will show up here.
          </p>
        </div>
      ) : (
        <>
          <div className="activity__list">
            {events.map((event) => (
              <ActivityEvent key={event.id} event={event} />
            ))}
          </div>
          {hasMore && (
            <div className="activity__more">
              <button className="activity__more-btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
