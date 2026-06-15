// Formatting helpers shared across the analytics views.
import { NODE_DEFS } from '../canvas/nodeDefs'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatNumber(n) {
  return (n ?? 0).toLocaleString('en-US')
}

// Human-friendly duration. ms → "240 ms", "1.6 s", "2m 5s".
export function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

// Fraction (0–1) → "91.5%", trimming a trailing ".0".
export function formatPercent(frac) {
  if (frac == null) return '—'
  return `${(frac * 100).toFixed(1).replace(/\.0$/, '')}%`
}

// 'YYYY-MM-DD' (a UTC day bucket) → "Jun 14", parsed by hand to avoid TZ shifts.
export function shortDate(ymd) {
  if (!ymd) return ''
  const [, m, d] = ymd.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}

// ISO timestamp → "just now" / "5m ago" / "3h ago" / "2d ago" / "Jun 3".
export function formatRelative(iso) {
  if (!iso) return 'Never'
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return shortDate(iso.slice(0, 10))
}

// Friendly node-type label, reusing the canvas node definitions.
export function prettyNodeType(type) {
  return NODE_DEFS[type]?.label || type
}

// Bar/segment color matched to the canvas node palette.
export function nodeColor(type) {
  if (type.startsWith('trigger-')) return '#22c55e'
  if (type === 'condition') return '#f59e0b'
  if (type.startsWith('ai-')) return '#a855f7'
  if (type.startsWith('output-')) return '#6b7280'
  return '#3b82f6' // actions + transform
}
