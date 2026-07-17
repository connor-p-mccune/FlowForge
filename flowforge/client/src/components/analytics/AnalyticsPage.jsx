import { useState, useEffect } from 'react'
import { apiFetch } from '../../services/api'
import Skeleton from '../Skeleton'
import SummaryCards from './SummaryCards'
import TimelineChart from './TimelineChart'
import NodeUsageChart from './NodeUsageChart'
import WorkflowsTable from './WorkflowsTable'
import StatusPageSection from './StatusPageSection'

const RANGES = [7, 30, 90]

export default function AnalyticsPage({ workspaceId }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [summary, timeline, nodeUsage, workflows] = await Promise.all([
          apiFetch(`/api/workspaces/${workspaceId}/analytics/summary?days=${days}`),
          apiFetch(`/api/workspaces/${workspaceId}/analytics/timeline?days=${days}`),
          apiFetch(`/api/workspaces/${workspaceId}/analytics/node-usage`),
          apiFetch(`/api/workspaces/${workspaceId}/analytics/workflows?days=${days}`),
        ])
        if (cancelled) return
        setData({
          summary: summary.summary,
          timeline: timeline.timeline,
          nodeUsage: nodeUsage.nodeUsage,
          workflows: workflows.workflows,
        })
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [workspaceId, days])

  return (
    <div className="analytics">
      <div className="analytics__header">
        <h1 className="analytics__title">Analytics</h1>
        <div className="analytics__ranges" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              className={`analytics__range-btn${days === r ? ' analytics__range-btn--active' : ''}`}
              onClick={() => setDays(r)}
              disabled={loading}
            >
              {r} days
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="analytics__error">Unable to load analytics — {error}</div>
      ) : loading ? (
        <AnalyticsSkeleton />
      ) : data.summary.totalExecutions === 0 ? (
        <div className="analytics__empty">
          <div className="analytics__empty-title">No executions yet</div>
          <p className="analytics__empty-hint">
            Run a workflow to see analytics{days < 90 ? ' — or widen the range to look further back' : ''}.
          </p>
        </div>
      ) : (
        <>
          <SummaryCards summary={data.summary} />
          <div className="analytics__charts">
            <TimelineChart data={data.timeline} />
            <NodeUsageChart data={data.nodeUsage} />
          </div>
          <WorkflowsTable workflows={data.workflows} />
        </>
      )}
      {/* Sharing lives below the charts; it renders even while they load —
          publishing a status page doesn't depend on analytics data. */}
      <StatusPageSection workspaceId={workspaceId} />
    </div>
  )
}

function AnalyticsSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="analytics__cards">
        {[0, 1, 2].map((i) => (
          <div key={i} className="analytics__card">
            <Skeleton width={90} height={12} />
            <Skeleton width={120} height={28} style={{ marginTop: 10 }} />
            <Skeleton width={150} height={10} style={{ marginTop: 10 }} />
          </div>
        ))}
      </div>
      <div className="analytics__charts">
        {[0, 1].map((i) => (
          <div key={i} className="analytics__panel">
            <Skeleton width={160} height={14} />
            <Skeleton height={240} style={{ marginTop: 12 }} />
          </div>
        ))}
      </div>
      <div className="analytics__table-wrap" style={{ padding: 16 }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={22} style={{ marginTop: i ? 10 : 0 }} />
        ))}
      </div>
    </div>
  )
}
