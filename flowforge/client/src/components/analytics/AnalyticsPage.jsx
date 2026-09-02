import { useState, useEffect } from 'react'
import { apiFetch } from '../../services/api'
import { useAuth } from '../../hooks/useAuth'
import Skeleton from '../Skeleton'
import SummaryCards from './SummaryCards'
import TimelineChart from './TimelineChart'
import NodeUsageChart from './NodeUsageChart'
import WorkflowsTable from './WorkflowsTable'
import StatusPageSection from './StatusPageSection'
import CostSection from './CostSection'
import ExposureSection from './ExposureSection'
import ScheduleLoadSection from './ScheduleLoadSection'

const RANGES = [7, 30, 90]

export default function AnalyticsPage({ workspaceId }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Only an owner may change the spend cap; everyone may read the numbers.
  // A failed lookup leaves it false, which hides an edit control rather than
  // offering one the server would refuse — the server checks the role again
  // regardless, so this is presentation, not authorization.
  const { user } = useAuth()
  const [isOwner, setIsOwner] = useState(false)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/workspaces/${workspaceId}/members`)
      .then(({ members }) => {
        if (cancelled) return
        setIsOwner((members || []).some((m) => m.userId === user?.id && m.role === 'owner'))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [workspaceId, user?.id])

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
      {/* Everything above is about volume: how many runs, how fast, how much.
          None of it says which workflow *matters* — a thousand runs that write
          a log and a thousand that charge a card are the same bar. This ranks
          the workspace by consequence instead, and renders whether or not
          anything has run: a workflow that can charge a card and never has is
          exactly the one nobody has looked at. */}
      <ExposureSection workspaceId={workspaceId} days={days} />
      {/* Everything above is about what already happened. This is what is
          going to: the scheduled load, and the shape it lands in. Not
          governed by the range buttons — a cron's next week does not
          depend on how far back you are looking. */}
      <ScheduleLoadSection workspaceId={workspaceId} />
      {/* Spend renders independently of the range buttons above: a budget is a
          calendar-month commitment, and showing "7 days" of it against a
          monthly cap would be two different questions in one panel. */}
      <CostSection workspaceId={workspaceId} canEdit={isOwner} />
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
