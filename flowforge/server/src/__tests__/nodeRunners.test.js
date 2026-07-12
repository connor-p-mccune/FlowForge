const http = require('http')

process.env.NODE_ENV = 'test'

const sendSlack = require('../services/nodeRunners/sendSlack')
const sendEmail = require('../services/nodeRunners/sendEmail')
const llmPrompt = require('../services/nodeRunners/llmPrompt')
const classify = require('../services/nodeRunners/classify')
const extract = require('../services/nodeRunners/extract')
const httpRequest = require('../services/nodeRunners/httpRequest')
const transform = require('../services/nodeRunners/transform')
const delay = require('../services/nodeRunners/delay')
const condition = require('../services/nodeRunners/condition')
const outputLog = require('../services/nodeRunners/outputLog')

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, () => resolve(server))
  })
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data ? JSON.parse(data) : {}))
  })
}

describe('sendSlack runner', () => {
  it('posts the message and returns ok', async () => {
    let received
    const server = await startServer(async (req, res) => {
      received = await readJson(req)
      res.writeHead(200)
      res.end('ok')
    })
    const port = server.address().port
    const out = await sendSlack({ webhookUrl: `http://127.0.0.1:${port}/`, text: 'hello' }, {})
    server.close()
    expect(out).toEqual({ ok: true, text: 'hello' })
    expect(received).toEqual({ text: 'hello' })
  })

  it('throws on a non-2xx response', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(500)
      res.end('nope')
    })
    const port = server.address().port
    await expect(
      sendSlack({ webhookUrl: `http://127.0.0.1:${port}/`, text: 'x' }, {})
    ).rejects.toThrow(/Slack webhook failed/)
    server.close()
  })

  it('requires a webhookUrl', async () => {
    await expect(sendSlack({ text: 'x' }, {})).rejects.toThrow(/webhookUrl is required/)
  })

  it('in dry-run mode reports what it would send without posting', async () => {
    let called = false
    const server = await startServer((req, res) => {
      called = true
      res.writeHead(200)
      res.end('ok')
    })
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/`
    const out = await sendSlack({ webhookUrl: url, text: 'hello' }, {}, true)
    server.close()
    expect(out).toEqual({ dryRun: true, wouldHaveSent: { channel: url, message: 'hello' } })
    expect(called).toBe(false)
  })
})

describe('sendEmail runner (simulated, no SMTP configured)', () => {
  it('serialises the message without sending', async () => {
    const out = await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Body' }, {})
    expect(out.sent).toBe(true)
    expect(out.simulated).toBe(true)
    expect(out.to).toBe('a@b.com')
    expect(out.subject).toBe('Hi')
    expect(out.messageId).toBeTruthy()
  })

  it('requires a recipient', async () => {
    await expect(sendEmail({ subject: 'Hi' }, {})).rejects.toThrow(/"to" is required/)
  })

  it('in dry-run mode reports what it would send without delivering', async () => {
    const out = await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Body' }, {}, true)
    expect(out).toEqual({
      dryRun: true,
      wouldHaveSent: { to: 'a@b.com', subject: 'Hi', body: 'Body' },
    })
    expect(out.sent).toBeUndefined()
  })

  it('in dry-run mode still falls back to serialised input and a default subject', async () => {
    const out = await sendEmail({ to: 'a@b.com' }, { order: 1 }, true)
    expect(out.wouldHaveSent.subject).toBe('(no subject)')
    expect(out.wouldHaveSent.body).toBe(JSON.stringify({ order: 1 }, null, 2))
  })

  it('still validates required fields in dry-run mode', async () => {
    await expect(sendEmail({ subject: 'Hi' }, {}, true)).rejects.toThrow(/"to" is required/)
  })
})

describe('AI node runners call the AI service over HTTP', () => {
  let server
  let lastReq
  let baseUrl

  beforeAll(async () => {
    server = await startServer(async (req, res) => {
      const body = await readJson(req)
      lastReq = { url: req.url, body }
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/llm') {
        if (body.prompt === 'FAIL') {
          res.writeHead(500)
          return res.end(JSON.stringify({ error: 'kaboom' }))
        }
        return res.end(JSON.stringify({ text: 'a summary' }))
      }
      if (req.url === '/classify') return res.end(JSON.stringify({ label: 'positive' }))
      if (req.url === '/extract') return res.end(JSON.stringify({ data: { name: 'Ada' } }))
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`
    process.env.AI_SERVICE_URL = baseUrl
  })

  afterAll(() => {
    server.close()
    delete process.env.AI_SERVICE_URL
  })

  it('llmPrompt sends the prompt and returns text', async () => {
    const out = await llmPrompt({ prompt: 'summarize', system: 'be terse' })
    expect(out).toEqual({ text: 'a summary' })
    expect(lastReq.url).toBe('/llm')
    expect(lastReq.body).toEqual({ prompt: 'summarize', system: 'be terse' })
  })

  it('classify sends text + labels and returns the label', async () => {
    const out = await classify({ text: 'great product', labels: ['positive', 'negative'] }, {})
    expect(out).toEqual({ label: 'positive' })
    expect(lastReq.body).toEqual({ text: 'great product', labels: ['positive', 'negative'] })
  })

  it('classify falls back to upstream input when text is empty', async () => {
    await classify({ labels: 'a,b' }, { foo: 1 })
    expect(lastReq.body.text).toBe(JSON.stringify({ foo: 1 }))
  })

  it('extract sends text + fields and returns data', async () => {
    const out = await extract({ text: 'Ada <ada@x.com>', fields: 'name' }, {})
    expect(out).toEqual({ data: { name: 'Ada' } })
    expect(lastReq.body).toEqual({ text: 'Ada <ada@x.com>', fields: 'name' })
  })

  it('validates required config', async () => {
    await expect(llmPrompt({})).rejects.toThrow(/prompt is required/)
    await expect(classify({ text: 'x' })).rejects.toThrow(/labels are required/)
    await expect(extract({ text: 'x' })).rejects.toThrow(/fields are required/)
  })

  it('surfaces errors returned by the AI service', async () => {
    await expect(llmPrompt({ prompt: 'FAIL' })).rejects.toThrow('kaboom')
  })
})

describe('httpRequest runner', () => {
  it('performs a GET and returns status + parsed JSON body', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hello: 'world' }))
    })
    const port = server.address().port
    const out = await httpRequest({ method: 'GET', url: `http://127.0.0.1:${port}/` }, {})
    server.close()
    expect(out).toEqual({ status: 200, body: { hello: 'world' } })
  })

  it('sends a JSON body on POST and defaults the Content-Type header', async () => {
    let received
    let contentType
    const server = await startServer(async (req, res) => {
      contentType = req.headers['content-type']
      received = await readJson(req)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ created: true }))
    })
    const port = server.address().port
    const out = await httpRequest(
      { method: 'POST', url: `http://127.0.0.1:${port}/`, body: '{"name":"Ada"}' },
      {}
    )
    server.close()
    expect(out.status).toBe(201)
    expect(received).toEqual({ name: 'Ada' })
    expect(contentType).toMatch(/application\/json/)
  })

  it('returns a non-JSON body as plain text', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('just text')
    })
    const port = server.address().port
    const out = await httpRequest({ url: `http://127.0.0.1:${port}/` }, {})
    server.close()
    expect(out).toEqual({ status: 200, body: 'just text' })
  })

  it('throws on a non-2xx response, including the status code', async () => {
    const server = await startServer((req, res) => {
      res.writeHead(404)
      res.end('missing')
    })
    const port = server.address().port
    await expect(
      httpRequest({ url: `http://127.0.0.1:${port}/` }, {})
    ).rejects.toThrow(/HTTP 404/)
    server.close()
  })

  it('requires a url', async () => {
    await expect(httpRequest({ method: 'GET' }, {})).rejects.toThrow(/url is required/)
  })

  it('rejects malformed JSON headers', async () => {
    await expect(
      httpRequest({ url: 'http://127.0.0.1:1/', headers: '{not json}' }, {})
    ).rejects.toThrow(/headers must be valid JSON/)
  })

  it('in dry-run mode reports the request it would send without making it', async () => {
    let called = false
    const server = await startServer((req, res) => {
      called = true
      res.writeHead(200)
      res.end('ok')
    })
    const port = server.address().port
    const url = `http://127.0.0.1:${port}/`
    const out = await httpRequest(
      { method: 'POST', url, headers: '{"X-Api-Key":"abc"}', body: '{"name":"Ada"}' },
      {},
      true
    )
    server.close()
    expect(called).toBe(false)
    expect(out.dryRun).toBe(true)
    expect(out.wouldHaveSent).toEqual({
      method: 'POST',
      url,
      // Content-Type is defaulted in for the body, mirroring a real send.
      headers: { 'X-Api-Key': 'abc', 'Content-Type': 'application/json' },
      body: '{"name":"Ada"}',
    })
  })
})

describe('transform runner', () => {
  it('parses a JSON template string into an object', async () => {
    const out = await transform({ template: '{"a": 1, "b": "two"}' }, {})
    expect(out).toEqual({ a: 1, b: 'two' })
  })

  it('passes upstream input through when the template is empty', async () => {
    const out = await transform({ template: '' }, { carried: true })
    expect(out).toEqual({ carried: true })
  })

  it('passes upstream input through when there is no template', async () => {
    const out = await transform({}, { carried: 7 })
    expect(out).toEqual({ carried: 7 })
  })

  it('returns an already-resolved object template as-is', async () => {
    const out = await transform({ template: { resolved: true } }, {})
    expect(out).toEqual({ resolved: true })
  })

  it('wraps an unparseable template string as { value }', async () => {
    const out = await transform({ template: 'not json at all' }, {})
    expect(out).toEqual({ value: 'not json at all' })
  })
})

describe('delay runner', () => {
  it('waits the requested time and passes input through with delayedMs', async () => {
    const out = await delay({ durationMs: 5 }, { foo: 'bar' })
    expect(out).toEqual({ foo: 'bar', delayedMs: 5 })
  })

  it('clamps negative durations to zero', async () => {
    const out = await delay({ durationMs: -100 }, {})
    expect(out.delayedMs).toBe(0)
  })

  it('treats a missing duration as zero', async () => {
    const out = await delay({}, { keep: 1 })
    expect(out).toEqual({ keep: 1, delayedMs: 0 })
  })
})

describe('condition runner', () => {
  it('compares with loose string equality by default', async () => {
    expect(await condition({ left: 5, right: '5' })).toEqual({ result: true })
    expect(await condition({ left: 'a', right: 'b' })).toEqual({ result: false })
  })

  it('supports not_equals', async () => {
    expect(await condition({ left: 'a', operator: 'not_equals', right: 'b' })).toEqual({ result: true })
  })

  it('supports contains', async () => {
    expect(await condition({ left: 'hello world', operator: 'contains', right: 'world' })).toEqual({ result: true })
    expect(await condition({ left: 'hello', operator: 'contains', right: 'zzz' })).toEqual({ result: false })
  })

  it('supports numeric greater_than and less_than', async () => {
    expect(await condition({ left: '10', operator: 'greater_than', right: '3' })).toEqual({ result: true })
    expect(await condition({ left: '2', operator: 'less_than', right: '3' })).toEqual({ result: true })
    expect(await condition({ left: '2', operator: 'greater_than', right: '3' })).toEqual({ result: false })
  })

  it('throws on an unknown operator', async () => {
    await expect(condition({ left: 1, operator: 'spaceship', right: 2 })).rejects.toThrow(/unknown operator/)
  })

  describe('expression operator', () => {
    it('evaluates a boolean expression against the merged input', async () => {
      const out = await condition(
        { operator: 'expression', expression: 'amount > 1000 && status == "pending"' },
        { amount: 1500, status: 'pending' }
      )
      expect(out).toEqual({ result: true })
    })

    it('exposes the whole input as the `input` alias', async () => {
      const out = await condition(
        { operator: 'expression', expression: 'input.user.role == "admin"' },
        { user: { role: 'admin' } }
      )
      expect(out).toEqual({ result: true })
    })

    it('coerces the result to a boolean with FXL truthiness', async () => {
      expect(await condition({ operator: 'expression', expression: 'len(items) > 0' }, { items: [] }))
        .toEqual({ result: false })
      expect(await condition({ operator: 'expression', expression: 'status in ["a", "b"]' }, { status: 'b' }))
        .toEqual({ result: true })
    })

    it('requires a non-empty expression', async () => {
      await expect(condition({ operator: 'expression' }, {})).rejects.toThrow(/expression is required/)
      await expect(condition({ operator: 'expression', expression: '  ' }, {})).rejects.toThrow(/expression is required/)
    })

    it('surfaces an expression error as a node failure', async () => {
      await expect(
        condition({ operator: 'expression', expression: '"abc" * 2' }, {})
      ).rejects.toThrow(/as a number/)
    })
  })
})

describe('outputLog runner', () => {
  it('returns the configured message and logs it', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const out = await outputLog({ message: 'done' }, {})
    expect(out).toEqual({ message: 'done' })
    expect(spy).toHaveBeenCalledWith('[output-log]', 'done')
    spy.mockRestore()
  })

  it('falls back to a serialised input when no message is configured', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const out = await outputLog({}, { value: 42 })
    expect(out).toEqual({ message: '{"value":42}' })
    spy.mockRestore()
  })
})
