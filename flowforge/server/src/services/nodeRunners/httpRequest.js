module.exports = async function runHttpRequest(config, input) {
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

  const options = { method, headers: parsedHeaders }
  if (body && method !== 'GET' && method !== 'HEAD') {
    options.body = typeof body === 'string' ? body : JSON.stringify(body)
    const hasContentType = Object.keys(parsedHeaders).some(
      (h) => h.toLowerCase() === 'content-type'
    )
    if (!hasContentType) options.headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(url, options)
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
