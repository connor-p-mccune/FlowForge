// POST /api/expressions/evaluate — the FXL playground endpoint. A failing
// expression is a 200 with ok:false (like the node test bench); only a
// malformed request is a 4xx.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn().mockResolvedValue(undefined) }) }))

const { app } = require('../index')

describe('POST /api/expressions/evaluate', () => {
  let token

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'fxl-user@example.com', password: 'password123', displayName: 'FXL' })
    token = res.body.token
  })

  const evaluate = (body) =>
    request(app).post('/api/expressions/evaluate').set('Authorization', `Bearer ${token}`).send(body)

  it('requires authentication', async () => {
    const res = await request(app).post('/api/expressions/evaluate').send({ expression: '1 + 1' })
    expect(res.status).toBe(401)
  })

  it('evaluates an expression against a scope', async () => {
    const res = await evaluate({
      expression: 'amount > 1000 && status == "open"',
      scope: { amount: 1500, status: 'open' },
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, result: true, resultType: 'boolean' })
  })

  it('returns the evaluated value with its type', async () => {
    const res = await evaluate({ expression: '{ id: item.id, n: len(items) }', scope: { item: { id: 7 }, items: [1, 2] } })
    expect(res.body).toMatchObject({ ok: true, result: { id: 7, n: 2 }, resultType: 'object' })
  })

  it('reports a syntax error as a 200 ok:false with a position', async () => {
    const res = await evaluate({ expression: 'amount >' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/Unexpected end/)
    expect(typeof res.body.position).toBe('number')
  })

  it('reports a runtime error as a 200 ok:false', async () => {
    const res = await evaluate({ expression: '"abc" * 2' })
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/as a number/)
  })

  it('reports an unknown function as a runtime error', async () => {
    const res = await evaluate({ expression: 'uppr(name)', scope: { name: 'x' } })
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toMatch(/Unknown function/)
  })

  it('normalises a missing value to null', async () => {
    const res = await evaluate({ expression: 'missing', scope: {} })
    expect(res.body).toMatchObject({ ok: true, result: null, resultType: 'null' })
  })

  it('400s on a missing expression or a non-object scope', async () => {
    expect((await evaluate({})).status).toBe(400)
    expect((await evaluate({ expression: '  ' })).status).toBe(400)
    expect((await evaluate({ expression: '1', scope: [1, 2] })).status).toBe(400)
  })

  it('400s on an over-long expression', async () => {
    const res = await evaluate({ expression: '1 + '.repeat(1000) + '1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/too long/)
  })

  it('cannot reach the host (sandboxed like the engine)', async () => {
    const res = await evaluate({ expression: 'x.constructor', scope: { x: {} } })
    expect(res.body).toMatchObject({ ok: true, result: null })
  })
})
