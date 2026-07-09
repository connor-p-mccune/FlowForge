// Approval routes: the inbox (GET /api/approvals), responding to a pending
// request, and the approvals block on the execution detail. The runner's wait
// semantics live in approvalNode.test.js; here the respond side goes through
// the real HTTP surface, including the end-to-end path where a live run is
// unblocked by the API call.

const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.APPROVAL_POLL_MS = '20'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { v4: uuidv4 } = require('uuid')
const { app } = require('../index')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

const gatedGraph = {
  nodes: [
    node('t1', 'trigger-manual'),
    node('gate', 'approval', { message: 'Ship to production?' }),
    node('ship', 'output-log', { message: 'shipping' }),
  ],
  edges: [
    { id: 't1-gate', source: 't1', target: 'gate' },
    { id: 'gate-ship', source: 'gate', target: 'ship', sourceHandle: 'true' },
  ],
}

async function waitForApproval(executionId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = db
      .prepare('SELECT * FROM execution_approvals WHERE execution_id = ?')
      .get(executionId)
    if (row) return row
    if (Date.now() > deadline) throw new Error('approval row never appeared')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('approval routes', () => {
  let token
  let outsiderToken
  let workspaceId

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'gatekeeper@example.com', password: 'password123', displayName: 'Gatekeeper' })
    token = res.body.token
    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bystander@example.com', password: 'password123', displayName: 'Bystander' })
    outsiderToken = outsider.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  async function startGatedRun() {
    const created = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Release ${uuidv4().slice(0, 8)}` })
    const workflow = created.body.workflow
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(gatedGraph)
    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/execute`)
      .set('Authorization', `Bearer ${token}`)
    const execution = res.body.execution
    const run = runExecution(execution.id, { publish: () => {} })
    const approval = await waitForApproval(execution.id)
    return { workflow, execution, approval, run }
  }

  it('approves a waiting run end-to-end through the API', async () => {
    const { execution, approval, run } = await startGatedRun()

    const res = await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'approve', note: '  LGTM — ship it  ' })
    expect(res.status).toBe(200)
    expect(res.body.approval).toMatchObject({
      status: 'approved',
      responded_by_name: 'Gatekeeper',
      note: 'LGTM — ship it',
    })

    await run
    const final = db.prepare('SELECT status FROM executions WHERE id = ?').get(execution.id)
    expect(final.status).toBe('completed')

    // The decision is on the workspace feed.
    const feed = db
      .prepare("SELECT * FROM activity_events WHERE event_type = 'approval.approved' AND entity_id = ?")
      .all(execution.id)
    expect(feed).toHaveLength(1)

    // …and on the run detail.
    const detail = await request(app)
      .get(`/api/executions/${execution.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.body.approvals).toHaveLength(1)
    expect(detail.body.approvals[0].status).toBe('approved')
  })

  it('lists pending approvals in the inbox for members only', async () => {
    const { approval, run } = await startGatedRun()

    const mine = await request(app)
      .get('/api/approvals')
      .set('Authorization', `Bearer ${token}`)
    expect(mine.status).toBe(200)
    expect(mine.body.approvals.map((a) => a.id)).toContain(approval.id)
    expect(mine.body.approvals.find((a) => a.id === approval.id).workflow_name).toMatch(/^Release/)

    const theirs = await request(app)
      .get('/api/approvals')
      .set('Authorization', `Bearer ${outsiderToken}`)
    expect(theirs.body.approvals.map((a) => a.id)).not.toContain(approval.id)

    const invalid = await request(app)
      .get('/api/approvals?status=bogus')
      .set('Authorization', `Bearer ${token}`)
    expect(invalid.status).toBe(400)

    await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'reject' })
    await run
  })

  it('rejects bad decisions and double responses', async () => {
    const { approval, run } = await startGatedRun()

    const bad = await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'maybe' })
    expect(bad.status).toBe(400)

    const first = await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'reject' })
    expect(first.status).toBe(200)

    const second = await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'approve' })
    expect(second.status).toBe(409)
    expect(second.body.error).toMatch(/already rejected/)

    await run
  })

  it('404s for non-members and unknown approvals', async () => {
    const { approval, run } = await startGatedRun()

    const foreign = await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ decision: 'approve' })
    expect(foreign.status).toBe(404)

    const unknown = await request(app)
      .post(`/api/approvals/${uuidv4()}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'approve' })
    expect(unknown.status).toBe(404)

    await request(app)
      .post(`/api/approvals/${approval.id}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'approve' })
    await run
  })

  it('requires authentication', async () => {
    const inbox = await request(app).get('/api/approvals')
    expect(inbox.status).toBe(401)
    const respond = await request(app)
      .post(`/api/approvals/${uuidv4()}/respond`)
      .send({ decision: 'approve' })
    expect(respond.status).toBe(401)
  })
})
