const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')

async function registerUser(email, displayName) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName })
  return res.body.token
}

describe('workspace CRUD', () => {
  let token

  beforeAll(async () => {
    token = await registerUser('ws-owner@example.com', 'Owner')
  })

  it('lists the default workspace created on register', async () => {
    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.workspaces).toHaveLength(1)
    expect(res.body.workspaces[0].name).toBe("Owner's Workspace")
  })

  it('creates a workspace and adds creator as owner', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Side Projects' })
    expect(res.status).toBe(201)
    expect(res.body.workspace.name).toBe('Side Projects')

    const list = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
    expect(list.body.workspaces).toHaveLength(2)
  })

  it('rejects creation without a name', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('renames a workspace', async () => {
    const created = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Old Name' })

    const res = await request(app)
      .put(`/api/workspaces/${created.body.workspace.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' })
    expect(res.status).toBe(200)
    expect(res.body.workspace.name).toBe('New Name')
  })

  it('deletes a workspace when owner', async () => {
    const created = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Doomed' })

    const res = await request(app)
      .delete(`/api/workspaces/${created.body.workspace.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(204)

    const get = await request(app)
      .get(`/api/workspaces/${created.body.workspace.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(get.status).toBe(404)
  })

  it('hides workspaces from non-members', async () => {
    const otherToken = await registerUser('stranger@example.com', 'Stranger')
    const created = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Private' })

    const res = await request(app)
      .get(`/api/workspaces/${created.body.workspace.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
    expect(res.status).toBe(404)
  })

  it('requires auth', async () => {
    const res = await request(app).get('/api/workspaces')
    expect(res.status).toBe(401)
  })
})
