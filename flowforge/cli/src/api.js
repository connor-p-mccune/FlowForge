// Thin client for the FlowForge public API (/api/v1). Wraps global fetch with
// auth, JSON handling, and errors that read like the server wrote them —
// because they usually did ({ error } bodies pass through verbatim).

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function createClient({ baseUrl, token }) {
  if (!baseUrl) {
    throw new ApiError(
      'No server configured. Run `flowforge login --url <url> --token <token>` or set FLOWFORGE_URL.'
    )
  }
  if (!token) {
    throw new ApiError(
      'No API token configured. Mint one in Settings → API tokens, then run `flowforge login` or set FLOWFORGE_TOKEN.'
    )
  }

  async function request(method, path, body, headers = {}) {
    let res
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new ApiError(`Could not reach ${baseUrl}: ${err.cause?.message || err.message}`)
    }
    let data = null
    try {
      data = await res.json()
    } catch {
      /* non-JSON body (proxy error page) — fall through to the status check */
    }
    if (!res.ok) {
      throw new ApiError(data?.error || `Request failed with HTTP ${res.status}`, res.status)
    }
    return data
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body, headers) => request('POST', path, body, headers),
  }
}

module.exports = { createClient, ApiError }
