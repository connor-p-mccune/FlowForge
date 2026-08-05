const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

// Authenticated fetch for endpoints that don't return JSON — the audit log's
// CSV export, today. Returns the response body as text rather than parsing it,
// but keeps the same auth and error contract as apiFetch, so a caller never has
// to hand-roll the Authorization header (and never has to smuggle a token
// through a query string to make a plain <a download> work).
export async function apiFetchText(path, options = {}) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const body = await res.text()
  if (!res.ok) {
    // Errors are still JSON even when the success path isn't.
    let message = 'Request failed'
    try {
      message = JSON.parse(body).error || message
    } catch {
      /* a non-JSON error body — keep the generic message */
    }
    throw new Error(message)
  }
  return body
}
