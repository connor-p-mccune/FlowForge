const http = require('http')

process.env.NODE_ENV = 'test'

const sendSlack = require('../services/nodeRunners/sendSlack')
const sendEmail = require('../services/nodeRunners/sendEmail')
const llmPrompt = require('../services/nodeRunners/llmPrompt')
const classify = require('../services/nodeRunners/classify')
const extract = require('../services/nodeRunners/extract')

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
