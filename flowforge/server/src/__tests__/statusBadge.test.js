// Status badges: the SVG renderer's mapping/escaping, and the public badge
// endpoint's token gate and status reflection.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { statusBadgeSvg, badgeForStatus, renderBadge } = require('../services/statusBadge')

describe('statusBadge renderer', () => {
  it('maps run statuses to messages and colors', () => {
    expect(badgeForStatus('completed')).toEqual({ message: 'passing', color: 'green' })
    expect(badgeForStatus('failed')).toEqual({ message: 'failing', color: 'red' })
    expect(badgeForStatus('cancelled')).toEqual({ message: 'cancelled', color: 'yellow' })
    expect(badgeForStatus('running')).toEqual({ message: 'running', color: 'blue' })
    expect(badgeForStatus('none')).toEqual({ message: 'no runs', color: 'grey' })
    expect(badgeForStatus('whatever')).toEqual({ message: 'unknown', color: 'grey' })
  })

  it('renders valid SVG carrying the label and message', () => {
    const svg = statusBadgeSvg('completed')
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(svg).toContain('flowforge')
    expect(svg).toContain('passing')
    expect(svg).toContain('#4c1') // green
    expect(svg).toContain('aria-label="flowforge: passing"')
  })

  it('escapes markup so a status string can never inject XML', () => {
    const svg = renderBadge({ label: 'a<b>&"', message: 'x', color: 'green' })
    expect(svg).not.toMatch(/<b>/)
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;')
  })
})

describe('GET /api/workflows/:id/badge.svg', () => {
  let token
  let workspaceId
  let workflowId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'badge-user@example.com', password: 'password123', displayName: 'Badger' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
    const wf = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Badged workflow' })
    workflowId = wf.body.workflow.id
  })

  // superagent doesn't parse image/svg+xml as text, so buffer the raw body
  // ourselves — the SVG string lands in res.body.
  function getBadge(url) {
    return request(app)
      .get(url)
      .buffer(true)
      .parse((res, cb) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => cb(null, data))
      })
  }

  function seedRun(status, triggerType = 'manual') {
    const id = uuidv4()
    db.prepare(
      'INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, workflowId, status, triggerType, new Date().toISOString())
    return id
  }

  async function mintBadge() {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/badge-token`)
      .set('Authorization', `Bearer ${token}`)
    return res.body.badgeToken
  }

  it('renders an unknown badge when no token is minted', async () => {
    const res = await getBadge(`/api/workflows/${workflowId}/badge.svg`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/)
    expect(res.body).toContain('unknown')
  })

  it('mints a token and reflects the latest run status', async () => {
    const badgeToken = await mintBadge()
    expect(badgeToken).toBeTruthy()

    // No runs yet.
    let res = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`)
    expect(res.body).toContain('no runs')

    seedRun('completed')
    res = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`)
    expect(res.body).toContain('passing')

    seedRun('failed')
    res = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`)
    expect(res.body).toContain('failing')
    expect(res.headers['cache-control']).toMatch(/max-age=60/)
  })

  it('ignores dry runs when choosing the latest status', async () => {
    const badgeToken = await mintBadge()
    seedRun('completed')
    seedRun('failed', 'dry-run') // newer, but a test run — must not move the badge
    const res = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`)
    expect(res.body).toContain('passing')
  })

  it('renders unknown for a wrong token and never confirms existence', async () => {
    await mintBadge()
    const wrong = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=nope`)
    expect(wrong.status).toBe(200)
    expect(wrong.body).toContain('unknown')

    // A completely unknown workflow id is indistinguishable.
    const ghost = await getBadge(`/api/workflows/${uuidv4()}/badge.svg?token=whatever`)
    expect(ghost.status).toBe(200)
    expect(ghost.body).toContain('unknown')
  })

  it('rotating the token invalidates the previous badge URL', async () => {
    const first = await mintBadge()
    const second = await mintBadge()
    expect(second).not.toBe(first)

    const stale = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${first}`)
    expect(stale.body).toContain('unknown')
    const fresh = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${second}`)
    expect(fresh.body).not.toContain('unknown')
  })

  it('turns the badge off on delete', async () => {
    const badgeToken = await mintBadge()
    const del = await request(app)
      .delete(`/api/workflows/${workflowId}/badge-token`)
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(204)
    const res = await getBadge(`/api/workflows/${workflowId}/badge.svg?token=${badgeToken}`)
    expect(res.body).toContain('unknown')
  })

  it('requires membership to mint a badge token', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'badge-outsider@example.com', password: 'password123', displayName: 'Out' })
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/badge-token`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(res.status).toBe(404)
  })
})
