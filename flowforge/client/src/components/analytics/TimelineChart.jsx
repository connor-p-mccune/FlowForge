import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { shortDate } from './format'

// Stacked daily executions: completed (green) vs. failed (red).
export default function TimelineChart({ data }) {
  return (
    <div className="analytics__panel">
      <div className="analytics__panel-title">
        Executions per day <span className="analytics__panel-sub">— completed vs. failed</span>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tick={{ fontSize: 11, fill: '#888' }}
            minTickGap={24}
            tickLine={false}
            axisLine={{ stroke: '#e5e5e5' }}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: '#888' }}
            tickLine={false}
            axisLine={false}
            width={36}
          />
          <Tooltip
            labelFormatter={shortDate}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e5e5' }}
            cursor={{ fill: 'rgba(79,70,229,0.06)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="completed" name="Completed" stackId="s" fill="#22c55e" radius={[0, 0, 0, 0]} />
          <Bar dataKey="failed" name="Failed" stackId="s" fill="#ef4444" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
