// Hand-rendered SVG status badges (shields.io "flat" style), zero-dependency
// like the metrics exporter. The app needs one badge shape — a two-cell
// "label | message" pill — not an image library, so the SVG is a template and
// text width is estimated per character (bundling real font metrics would be
// far more code for a cosmetic gain). Every dynamic value is XML-escaped, so a
// workflow can't inject markup through its status.

const COLORS = {
  green: '#4c1',
  red: '#e05d44',
  blue: '#007ec6',
  yellow: '#dfb317',
  grey: '#9f9f9f',
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])
  )
}

// Approximate advance width (px) of a string at the badge's 11px font. Rough
// per-class widths are plenty for the flat look — the goal is a snug pill, not
// pixel-perfect kerning.
function textWidth(str) {
  let w = 0
  for (const ch of String(str)) {
    if (/[A-Z]/.test(ch)) w += 7
    else if (/[ijl.,:'!|]/.test(ch)) w += 3
    else if (/[mwMW]/.test(ch)) w += 9
    else w += 6.2
  }
  return Math.ceil(w)
}

// Map a workflow's latest-run status to a badge message + color. 'unknown' is
// the deliberate fallback for a missing/invalid badge token, so the endpoint
// never confirms or denies a workflow's existence.
function badgeForStatus(status) {
  switch (status) {
    case 'completed':
      return { message: 'passing', color: 'green' }
    case 'failed':
      return { message: 'failing', color: 'red' }
    case 'cancelled':
      return { message: 'cancelled', color: 'yellow' }
    case 'running':
    case 'pending':
      return { message: 'running', color: 'blue' }
    case 'none':
      return { message: 'no runs', color: 'grey' }
    default:
      return { message: 'unknown', color: 'grey' }
  }
}

// Render a flat two-cell badge. Positions/lengths are ×10 because the flat
// template renders text at 10× scale then downscales for crisp sub-pixel text.
function renderBadge({ label, message, color }) {
  const fill = COLORS[color] || COLORS.grey
  const pad = 6
  const labelW = textWidth(label) + pad * 2
  const msgW = textWidth(message) + pad * 2
  const total = labelW + msgW
  const labelX = (labelW / 2) * 10
  const msgX = (labelW + msgW / 2) * 10
  const safeLabel = escapeXml(label)
  const safeMsg = escapeXml(message)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${safeLabel}: ${safeMsg}">
  <title>${safeLabel}: ${safeMsg}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${msgW}" height="20" fill="${fill}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110" text-rendering="geometricPrecision">
    <text x="${labelX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelW - pad * 2) * 10}">${safeLabel}</text>
    <text x="${labelX}" y="140" transform="scale(.1)" textLength="${(labelW - pad * 2) * 10}">${safeLabel}</text>
    <text x="${msgX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(msgW - pad * 2) * 10}">${safeMsg}</text>
    <text x="${msgX}" y="140" transform="scale(.1)" textLength="${(msgW - pad * 2) * 10}">${safeMsg}</text>
  </g>
</svg>`
}

// The full badge for a workflow's latest run status.
function statusBadgeSvg(status, { label = 'flowforge' } = {}) {
  return renderBadge({ label, ...badgeForStatus(status) })
}

module.exports = { statusBadgeSvg, badgeForStatus, renderBadge, escapeXml, textWidth }
