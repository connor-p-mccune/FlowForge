// Terminal output helpers: ANSI colors (honoring NO_COLOR and non-TTY
// stdout, so piped output stays clean) and a plain column table.

const CODES = {
  green: '32',
  red: '31',
  yellow: '33',
  gray: '90',
  bold: '1',
}

function colorEnabled() {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY)
}

function paint(text, code) {
  return colorEnabled() ? `[${code}m${text}[0m` : String(text)
}

const green = (t) => paint(t, CODES.green)
const red = (t) => paint(t, CODES.red)
const yellow = (t) => paint(t, CODES.yellow)
const gray = (t) => paint(t, CODES.gray)
const bold = (t) => paint(t, CODES.bold)

// Run/step statuses → a consistent palette across every command.
function statusColored(status) {
  if (status === 'completed' || status === 'succeeded' || status === 'deployed') return green(status)
  if (status === 'failed') return red(status)
  if (status === 'running' || status === 'pending') return yellow(status)
  return gray(status)
}

// Render rows as aligned columns. `columns` is [{ key, label }]; widths come
// from the visible (uncolored) content, so colored cells still line up.
function table(rows, columns) {
  const visible = (v) => String(v ?? '').replace(/\[[0-9;]*m/g, '')
  const widths = columns.map((col) =>
    Math.max(visible(col.label).length, ...rows.map((row) => visible(row[col.key]).length))
  )
  const line = (cells) =>
    cells
      .map((cell, i) => String(cell ?? '') + ' '.repeat(widths[i] - visible(cell).length))
      .join('  ')
      .trimEnd()
  const header = line(columns.map((c) => bold(c.label)))
  return [header, ...rows.map((row) => line(columns.map((c) => row[c.key])))].join('\n')
}

// "2026-07-09T12:00:00Z", "…12:00:04Z" → "4.0s"; open-ended runs use now.
function formatDuration(startedAt, finishedAt) {
  if (!startedAt) return ''
  const ms = (finishedAt ? new Date(finishedAt) : new Date()) - new Date(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

module.exports = { green, red, yellow, gray, bold, statusColored, table, formatDuration }
