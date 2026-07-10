// Test scaffolding: a stub /api/v1 server and a ctx whose log output is
// captured for assertions. Commands talk to a real client over real HTTP —
// the tests cover the wire format, not internal wiring.

const http = require('http')
const { createClient } = require('../src/api')

// handler(method, path, body, headers) -> { status = 200, json = {} }
function startStub(handler) {
  return new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        const body = raw ? JSON.parse(raw) : undefined
        requests.push({ method: req.method, path: req.url, body, headers: req.headers })
        const out = handler(req.method, req.url, body, req.headers) || {}
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out.json ?? {}))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve({
        baseUrl,
        requests,
        api: createClient({ baseUrl, token: 'ffp_testtoken' }),
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function makeCtx(api) {
  const lines = []
  return { api, log: (line) => lines.push(String(line)), lines, output: () => lines.join('\n') }
}

module.exports = { startStub, makeCtx }
