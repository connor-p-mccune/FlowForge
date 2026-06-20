const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const jwt = require('jsonwebtoken')
const { app } = require('../index')
const activityService = require('../services/activityService')

async function register(email, displayName) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName })
  return { token: res.body.token, userId: jwt.decode(res.body.token).id }
}

async function firstWorkspaceId(token) {
  const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
  return res.body.workspaces[0].id
}

const authed = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`)

let ownerToken, ownerId, wsId, memberToken, memberId, wfId

beforeAll(async () => {
  const owner = await register('act-owner@example.com', 'Olivia Owner')
  ownerToken = owner.token
  ownerId = owner.userId
  wsId = await firstWorkspaceId(ownerToken)

  const member = await register('act-member@example.com', 'Marty Member')
  memberToken = member.token
  memberId = member.userId
})

describe('activity is logged by real actions', () => {
  it('logs workflow.created with the actor display name joined in', async () => {
    const res = await authed('post', `/api/workspaces/${wsId}/workflows`, ownerToken)
      .send({ name: 'Webhook Alerter' })
    expect(res.status).toBe(201)
    wfId = res.body.workflow.id

    const feed = await authed('get', `/api/workspaces/${wsId}/activity`, ownerToken)
    expect(feed.status).toBe(200)
    expect(feed.body.activity[0]).toMatchObject({
      event_type: 'workflow.created',
      entity_type: 'workflow',
      entity_id: wfId,
      entity_name: 'Webhook Alerter',
      actor_id: ownerId,
      actor_display_name: 'Olivia Owner',
    })
    expect(typeof feed.body.activity[0].created_at).toBe('string')
  })

  it('logs workflow.deployed with the version in metadata', async () => {
    const res = await authed('post', `/api/workflows/${wfId}/deploy`, ownerToken).send({})
    expect(res.status).toBe(201)

    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=workflows`, ownerToken)
    const deployed = feed.body.activity.find((e) => e.event_type === 'workflow.deployed')
    expect(deployed).toBeTruthy()
    expect(deployed.entity_name).toBe('Webhook Alerter')
    expect(deployed.metadata).toMatchObject({ version: 1 })
  })

  it('logs member.invited and filters by category', async () => {
    const res = await authed('post', `/api/workspaces/${wsId}/members`, ownerToken)
      .send({ email: 'act-member@example.com' })
    expect(res.status).toBe(201)

    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=members`, ownerToken)
    expect(feed.body.activity).toHaveLength(1)
    expect(feed.body.activity[0]).toMatchObject({
      event_type: 'member.invited',
      entity_type: 'member',
      entity_id: memberId,
      entity_name: 'Marty Member',
      actor_id: ownerId,
    })
  })

  it('returns events newest-first', async () => {
    const feed = await authed('get', `/api/workspaces/${wsId}/activity`, ownerToken)
    const types = feed.body.activity.map((e) => e.event_type)
    expect(types[0]).toBe('member.invited') // the most recent action
    expect(types).toEqual(expect.arrayContaining(['workflow.created', 'workflow.deployed']))
  })
})

describe('workflow edits log a coalesced workflow.updated event', () => {
  const updatedEntries = (feed) =>
    feed.body.activity.filter((e) => e.event_type === 'workflow.updated')

  it('logs workflow.updated on a graph save', async () => {
    const res = await authed('put', `/api/workflows/${wfId}/graph`, ownerToken)
      .send({ nodes: [], edges: [] })
    expect(res.status).toBe(200)

    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=workflows`, ownerToken)
    const updated = updatedEntries(feed)
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({
      event_type: 'workflow.updated',
      entity_type: 'workflow',
      entity_id: wfId,
      entity_name: 'Webhook Alerter',
      actor_id: ownerId,
    })
  })

  it('coalesces a burst of edits into the one entry', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await authed('put', `/api/workflows/${wfId}/graph`, ownerToken)
        .send({ nodes: [], edges: [] })
      expect(res.status).toBe(200)
    }
    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=workflows`, ownerToken)
    expect(updatedEntries(feed)).toHaveLength(1) // still one, not five
  })

  it('a rename coalesces too and refreshes the entry name', async () => {
    const res = await authed('put', `/api/workflows/${wfId}`, ownerToken)
      .send({ name: 'Renamed Flow' })
    expect(res.status).toBe(200)

    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=workflows`, ownerToken)
    const updated = updatedEntries(feed)
    expect(updated).toHaveLength(1)
    expect(updated[0].entity_name).toBe('Renamed Flow')
  })
})

describe('GET /workspaces/:id/activity — auth & pagination', () => {
  it('requires auth', async () => {
    const res = await request(app).get(`/api/workspaces/${wsId}/activity`)
    expect(res.status).toBe(401)
  })

  it('hides the feed from non-members (404)', async () => {
    const stranger = await register('act-stranger@example.com', 'Stranger')
    const res = await authed('get', `/api/workspaces/${wsId}/activity`, stranger.token)
    expect(res.status).toBe(404)
  })

  it('paginates with limit + before cursor without overlap', async () => {
    const page1 = await authed('get', `/api/workspaces/${wsId}/activity?limit=2`, ownerToken)
    expect(page1.body.activity).toHaveLength(2)
    expect(page1.body.hasMore).toBe(true)

    const before = page1.body.activity[page1.body.activity.length - 1].created_at
    const page2 = await authed(
      'get',
      `/api/workspaces/${wsId}/activity?limit=2&before=${encodeURIComponent(before)}`,
      ownerToken
    )
    const ids1 = page1.body.activity.map((e) => e.id)
    const ids2 = page2.body.activity.map((e) => e.id)
    expect(ids2.some((id) => ids1.includes(id))).toBe(false)
  })

  it('clamps limit to at most 100', async () => {
    const res = await authed('get', `/api/workspaces/${wsId}/activity?limit=9999`, ownerToken)
    expect(res.status).toBe(200)
    expect(res.body.activity.length).toBeLessThanOrEqual(100)
  })
})

describe('DELETE /workspaces/:id/members/:userId', () => {
  it('refuses to remove the last owner', async () => {
    const res = await authed('delete', `/api/workspaces/${wsId}/members/${ownerId}`, ownerToken)
    expect(res.status).toBe(400)
  })

  it('rejects a non-owner requester (403)', async () => {
    const res = await authed('delete', `/api/workspaces/${wsId}/members/${ownerId}`, memberToken)
    expect(res.status).toBe(403)
  })

  it('404 for a target who is not a member', async () => {
    const res = await authed('delete', `/api/workspaces/${wsId}/members/nope-not-a-user`, ownerToken)
    expect(res.status).toBe(404)
  })

  it('removes a member, logs member.removed, and cuts off their access', async () => {
    const res = await authed('delete', `/api/workspaces/${wsId}/members/${memberId}`, ownerToken)
    expect(res.status).toBe(204)

    const gone = await authed('get', `/api/workspaces/${wsId}/activity`, memberToken)
    expect(gone.status).toBe(404)

    const feed = await authed('get', `/api/workspaces/${wsId}/activity?category=members`, ownerToken)
    expect(feed.body.activity[0]).toMatchObject({
      event_type: 'member.removed',
      entity_id: memberId,
      entity_name: 'Marty Member',
    })
  })
})

describe('activityService.logEvent', () => {
  it('inserts a row and emits activity-event to the workspace room', () => {
    const emitted = []
    const fakeIo = {
      to(room) {
        return { emit: (name, payload) => emitted.push({ room, name, payload }) }
      },
    }
    activityService.init(fakeIo)

    const event = activityService.logEvent(wsId, ownerId, 'workflow.restored', {
      type: 'workflow', id: wfId, name: 'Webhook Alerter', metadata: { version: 3 },
    })

    expect(event).toMatchObject({
      workspace_id: wsId,
      actor_id: ownerId,
      actor_display_name: 'Olivia Owner',
      event_type: 'workflow.restored',
      entity_name: 'Webhook Alerter',
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0].room).toBe(`workspace:${wsId}`)
    expect(emitted[0].name).toBe('activity-event')
    expect(emitted[0].payload.event.event_type).toBe('workflow.restored')
    expect(emitted[0].payload.event.metadata).toEqual({ version: 3 })
  })

  it('never throws on a bad workspace id (best-effort)', () => {
    activityService.init(null)
    expect(() => activityService.logEvent('no-such-workspace', ownerId, 'workflow.created', {
      type: 'workflow', id: 'x', name: 'Ghost',
    })).not.toThrow()
  })
})
