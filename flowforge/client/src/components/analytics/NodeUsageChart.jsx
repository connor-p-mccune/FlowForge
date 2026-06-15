import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, LabelList, Cell,
} from 'recharts'
import { prettyNodeType, nodeColor, formatDuration, formatNumber } from './format'

function UsageTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null
  const d = payload[0].payload
  return (
    <div className="analytics__tooltip">
      <div className="analytics__tooltip-title">{prettyNodeType(d.nodeType)}</div>
      <div>{formatNumber(d.executions)} executions</div>
      <div>Avg {formatDuration(d.avgDurationMs)}</div>
      <div className="analytics__tooltip-sub">{formatNumber(d.count)} in workflow graphs</div>
    </div>
  )
}

// Horizontal bars: how often each node type ran (most-used first), labelled with
// its average execution time. Only types that have actually executed are shown.
export default function NodeUsageChart({ data }) {
  const rows = data.filter((d) => d.executions > 0)
  const height = Math.max(160, rows.length * 34 + 24)

  return (
    <div className="analytics__panel">
      <div className="analytics__panel-title">
        Node usage <span className="analytics__panel-sub">— runs per type, avg time labelled</span>
      </div>
      {rows.length === 0 ? (
        <p className="analytics__panel-empty">No node executions in this workspace yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart layout="vertical" data={rows} margin={{ top: 4, right: 72, left: 8, bottom: 4 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="nodeType"
              tickFormatter={prettyNodeType}
              tick={{ fontSize: 12, fill: '#555' }}
              tickLine={false}
              axisLine={false}
              width={104}
            />
            <Tooltip content={<UsageTooltip />} cursor={{ fill: 'rgba(79,70,229,0.06)' }} />
            <Bar dataKey="executions" radius={[0, 4, 4, 0]} barSize={18} isAnimationActive={false}>
              {rows.map((d) => (
                <Cell key={d.nodeType} fill={nodeColor(d.nodeType)} />
              ))}
              <LabelList
                dataKey="avgDurationMs"
                position="right"
                formatter={(v) => (v ? formatDuration(v) : '')}
                style={{ fontSize: 11, fill: '#888' }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
