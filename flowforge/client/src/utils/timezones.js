// The zone list the schedule picker offers.
//
// Modern engines expose the whole IANA set through Intl.supportedValuesOf, which
// is the right source — it matches exactly what the server will accept, because
// the server validates against its own Intl. Where it's missing (older Safari,
// older Node under jsdom) a curated shortlist keeps the picker useful rather
// than empty; a user on such a browser can still type any zone name, and the
// server is the authority either way.

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Warsaw',
  'Europe/Moscow',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

// Every zone the browser knows, UTC first (the default, and the meaning of an
// unset zone server-side). Computed once — the list is ~400 strings and never
// changes within a session.
let cached = null

export function listTimeZones() {
  if (cached) return cached
  let zones
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : null
  } catch {
    zones = null
  }
  const all = zones && zones.length > 0 ? zones : FALLBACK_ZONES
  cached = ['UTC', ...all.filter((z) => z !== 'UTC')]
  return cached
}

// The viewer's own zone, offered as a one-click default because it is almost
// always the one they mean. Falls back to UTC if the browser won't say.
export function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
