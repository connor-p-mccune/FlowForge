const { safeFetch } = require('../ssrfGuard')

// isDryRun (test mode): build the request as normal but, instead of sending it,
// report the method/url/headers/body that would have gone out.
//
// ctx.traceparent carries the W3C trace context identifying this step, which is
// forwarded so the service being called records its work as a child of this
// exact node — the run stops being an opaque 4-second box in somebody else's
// trace. An explicit `traceparent` in the node's own headers always wins: a
// user hand-setting one is deliberately joining a different trace, and silently
// overwriting it would break exactly the case they went out of their way to
// build.
module.exports = async function runHttpRequest(config, _input, isDryRun, ctx) {
  const { method = 'GET', url, headers = '{}', body = '' } = config
  if (!url) throw new Error('HTTP node: url is required')

  let parsedHeaders
  try {
    parsedHeaders = typeof headers === 'string'
      ? (headers.trim() ? JSON.parse(headers) : {})
      : headers || {}
  } catch {
    throw new Error('HTTP node: headers must be valid JSON')
  }

  const hasHeader = (name) =>
    Object.keys(parsedHeaders).some((h) => h.toLowerCase() === name.toLowerCase())

  if (ctx?.traceparent && !hasHeader('traceparent')) {
    parsedHeaders.traceparent = ctx.traceparent
  }

  // The step's idempotency key, when the node declared this endpoint
  // deduplicates (services/stepIdempotency.js). Stable across retries, resumes
  // and crash recoveries of the same logical step, so the far side recognises
  // the repeat — which is the whole reason a workflow can safely re-run a
  // request whose outcome nobody recorded.
  //
  // An explicitly configured header always wins, exactly as it does for
  // `traceparent`: an author setting their own key is doing so deliberately, and
  // overwriting it would break the case they went out of their way to build.
  if (ctx?.idempotencyKey && !hasHeader(ctx.idempotencyKey.name)) {
    parsedHeaders[ctx.idempotencyKey.name] = ctx.idempotencyKey.value
  }

  const options = { method, headers: parsedHeaders }
  if (body && method !== 'GET' && method !== 'HEAD') {
    options.body = typeof body === 'string' ? body : JSON.stringify(body)
    const hasContentType = Object.keys(parsedHeaders).some(
      (h) => h.toLowerCase() === 'content-type'
    )
    if (!hasContentType) options.headers['Content-Type'] = 'application/json'
  }

  if (isDryRun) {
    return {
      dryRun: true,
      wouldHaveSent: { method, url, headers: options.headers, body: options.body ?? null },
    }
  }

  const res = await safeFetch(url, options)
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  if (!res.ok) {
    const preview = typeof data === 'string' ? data : JSON.stringify(data)
    throw new Error(`HTTP ${res.status}: ${preview.slice(0, 200)}`)
  }

  return { status: res.status, body: data }
}
