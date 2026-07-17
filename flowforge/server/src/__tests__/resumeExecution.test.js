// Resume-from-failure: the resume route's eligibility rules, and the engine's
// reuse of a source run's succeeded step outputs — only the failed remainder
// re-executes, branch decisions replay identically, and anything downstream of
// a node that actually re-ran runs fresh.

const http = require('http')
const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'
process.env.EXEC_MAX_ATTEMPTS = '1'
process.env.APPROVAL_POLL_MS = '25'

const mockAdd = jest.fn().mockResolvedValue(undefined)
jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: mockAdd }) }))
const mockPublish = jest.fn().mockResolvedValue(1)
jest.mock('../config/redis', () => ({ publish: (...a) => mockPublish(...a) }))

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
const edge = (source, target, sourceHandle = null) => ({
  id: `${source}-${target}${sourceHandle ? `-${sourceHandle}` : ''}`,
  source,
  target,
  sourceHandle,
})

function getExecution(id) {
  return db.prepare('SELECT * FROM executions WHERE id = ?').get(id)
}

function stepsByNode(executionId) {
  const rows = db
    .prepare('SELECT * FROM execution_steps WHERE execution_id = ? ORDER BY rowid')
    .all(executionId)
  return Object.fromEntries(rows.map((r) => [r.node_id, r]))
}

describe('resume from failure', () => {
  let token
  let workspaceId

  // Controllable upstream: counts hits per path, fails the paths in failPaths.
  let server
  let baseUrl
  const hits = {}
  const failPaths = new Set()

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1
      if (failPaths.has(req.url)) {
        res.statusCode = 500
        res.end('boom')
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, path: req.url }))
      }
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'resume-user@example.com', password: 'password123', displayName: 'Resumer' })
    token = res.body.token
    const ws = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`)
    workspaceId = ws.body.workspaces[0].id
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const httpNode = (id, path) =>
    node(id, 'action-http', { method: 'GET', url: `${baseUrl}${path}`, headers: '{}' })

  async function createWorkflow(graph) {
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/workflows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Resumable ${uuidv4().slice(0, 8)}` })
    const workflow = res.body.workflow
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(graph)
    return workflow
  }

  async function startRun(workflowId) {
    const res = await request(app)
      .post(`/api/workflows/${workflowId}/execute`)
      .set('Authorization', `Bearer ${token}`)
    return res.body.execution
  }

  async function resume(executionId) {
    return request(app)
      .post(`/api/executions/${executionId}/resume`)
      .set('Authorization', `Bearer ${token}`)
  }

  it('reuses succeeded steps and re-executes only the failed remainder', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        httpNode('a', '/linear-a'),
        httpNode('b', '/linear-b'),
        node('log', 'output-log', { message: 'done' }),
      ],
      edges: [edge('t1', 'a'), edge('a', 'b'), edge('b', 'log')],
    }
    const workflow = await createWorkflow(graph)
    const original = await startRun(workflow.id)

    failPaths.add('/linear-b')
    await runExecution(original.id, { publish: () => {} })
    expect(getExecution(original.id).status).toBe('failed')
    expect(hits['/linear-a']).toBe(1)

    failPaths.delete('/linear-b')
    const res = await resume(original.id)
    expect(res.status).toBe(202)
    expect(res.body.execution.trigger_type).toBe('resume')
    expect(res.body.execution.resumed_from_execution_id).toBe(original.id)
    // The route enqueued the job; the worker is mocked, so run it directly.
    expect(mockAdd).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: res.body.execution.id, workflowId: workflow.id }),
      { priority: 5 }
    )
    await runExecution(res.body.execution.id, { publish: () => {} })

    expect(getExecution(res.body.execution.id).status).toBe('completed')
    const steps = stepsByNode(res.body.execution.id)
    expect(steps.t1.status).toBe('reused')
    expect(steps.a.status).toBe('reused')
    expect(steps.b.status).toBe('succeeded')
    expect(steps.log.status).toBe('succeeded')

    // The healthy prefix was not re-executed; the failed node was.
    expect(hits['/linear-a']).toBe(1)
    expect(hits['/linear-b']).toBe(2)

    // The reused step carries the source run's recorded output.
    const priorSteps = stepsByNode(original.id)
    expect(steps.a.output_json).toBe(priorSteps.a.output_json)
  })

  it('replays branch decisions identically: the dead branch re-skips', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('cond', 'condition', { left: 'x', operator: 'equals', right: 'x' }),
        httpNode('gated', '/branch-gated'),
        node('other', 'output-log', { message: 'false branch' }),
      ],
      edges: [
        edge('t1', 'cond'),
        edge('cond', 'gated', 'true'),
        edge('cond', 'other', 'false'),
      ],
    }
    const workflow = await createWorkflow(graph)
    const original = await startRun(workflow.id)

    failPaths.add('/branch-gated')
    await runExecution(original.id, { publish: () => {} })
    expect(getExecution(original.id).status).toBe('failed')

    failPaths.delete('/branch-gated')
    const res = await resume(original.id)
    await runExecution(res.body.execution.id, { publish: () => {} })

    expect(getExecution(res.body.execution.id).status).toBe('completed')
    const steps = stepsByNode(res.body.execution.id)
    expect(steps.cond.status).toBe('reused')
    expect(steps.gated.status).toBe('succeeded')
    expect(steps.other.status).toBe('skipped')
  })

  it('does not reuse a step downstream of a node that re-executed', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        httpNode('a', '/fresh-a'),
        httpNode('b', '/fresh-b'),
        httpNode('c', '/fresh-c'),
      ],
      edges: [edge('t1', 'a'), edge('a', 'b'), edge('b', 'c')],
    }
    const workflow = await createWorkflow(graph)
    const original = await startRun(workflow.id)

    failPaths.add('/fresh-c')
    await runExecution(original.id, { publish: () => {} })
    expect(getExecution(original.id).status).toBe('failed')
    expect(hits['/fresh-b']).toBe(1)

    // Replace node a with a2 before resuming: a2 has no prior output, so it
    // executes — and b, though it succeeded before, sits downstream of a node
    // that re-ran, so its recorded output can no longer be trusted.
    const edited = {
      nodes: [
        node('t1', 'trigger-manual'),
        httpNode('a2', '/fresh-a2'),
        httpNode('b', '/fresh-b'),
        httpNode('c', '/fresh-c'),
      ],
      edges: [edge('t1', 'a2'), edge('a2', 'b'), edge('b', 'c')],
    }
    await request(app)
      .put(`/api/workflows/${workflow.id}/graph`)
      .set('Authorization', `Bearer ${token}`)
      .send(edited)

    failPaths.delete('/fresh-c')
    const res = await resume(original.id)
    await runExecution(res.body.execution.id, { publish: () => {} })

    expect(getExecution(res.body.execution.id).status).toBe('completed')
    const steps = stepsByNode(res.body.execution.id)
    expect(steps.t1.status).toBe('reused')
    expect(steps.a2.status).toBe('succeeded')
    expect(steps.b.status).toBe('succeeded') // re-executed, not reused
    expect(hits['/fresh-b']).toBe(2)
  })

  it('does not ask a human again: a granted approval gate is reused', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('gate', 'approval', { message: 'Ship it?' }),
        httpNode('deploy', '/approved-deploy'),
      ],
      edges: [edge('t1', 'gate'), edge('gate', 'deploy', 'true')],
    }
    const workflow = await createWorkflow(graph)
    const original = await startRun(workflow.id)

    failPaths.add('/approved-deploy')
    const run = runExecution(original.id, { publish: () => {} })
    // Approve the gate as soon as the runner files it.
    const deadline = Date.now() + 5000
    let approval
    while (!approval && Date.now() < deadline) {
      approval = db
        .prepare("SELECT * FROM execution_approvals WHERE execution_id = ? AND status = 'pending'")
        .get(original.id)
      if (!approval) await new Promise((r) => setTimeout(r, 20))
    }
    expect(approval).toBeTruthy()
    db.prepare(
      "UPDATE execution_approvals SET status = 'approved', responded_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), approval.id)
    await run
    expect(getExecution(original.id).status).toBe('failed')

    failPaths.delete('/approved-deploy')
    const res = await resume(original.id)
    await runExecution(res.body.execution.id, { publish: () => {} })

    expect(getExecution(res.body.execution.id).status).toBe('completed')
    const steps = stepsByNode(res.body.execution.id)
    expect(steps.gate.status).toBe('reused')
    expect(steps.deploy.status).toBe('succeeded')

    // No second approval request was filed anywhere.
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM execution_approvals WHERE workflow_id = ?')
      .get(workflow.id)
    expect(n).toBe(1)
  })

  it('resumes a cancelled run', async () => {
    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual'), httpNode('a', '/cancelled-a')],
      edges: [edge('t1', 'a')],
    })
    const original = await startRun(workflow.id) // stays pending — queue mocked
    await request(app)
      .post(`/api/executions/${original.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)
    expect(getExecution(original.id).status).toBe('cancelled')

    const res = await resume(original.id)
    expect(res.status).toBe(202)
    await runExecution(res.body.execution.id, { publish: () => {} })
    expect(getExecution(res.body.execution.id).status).toBe('completed')
  })

  it('keeps a resumed dry-run a dry-run', async () => {
    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual'), httpNode('a', '/dry-a')],
      edges: [edge('t1', 'a')],
    })
    const test = await request(app)
      .post(`/api/workflows/${workflow.id}/test`)
      .set('Authorization', `Bearer ${token}`)
    await request(app)
      .post(`/api/executions/${test.body.execution.id}/cancel`)
      .set('Authorization', `Bearer ${token}`)

    mockAdd.mockClear()
    const res = await resume(test.body.execution.id)
    expect(res.status).toBe(202)
    expect(res.body.execution.trigger_type).toBe('dry-run')
    expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }), { priority: 1 })
  })

  it('rejects resuming a run that is not failed or cancelled', async () => {
    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual')],
      edges: [],
    })
    const execution = await startRun(workflow.id)
    await runExecution(execution.id, { publish: () => {} })
    expect(getExecution(execution.id).status).toBe('completed')

    const completed = await resume(execution.id)
    expect(completed.status).toBe(409)
    expect(completed.body.error).toMatch(/failed or cancelled/)

    const pending = await startRun(workflow.id)
    const stillPending = await resume(pending.id)
    expect(stillPending.status).toBe(409)
  })

  it('resumes via the public API with a trigger-scoped token', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'resume-test', scopes: ['trigger'] })
    const pat = minted.body.token

    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual'), httpNode('a', '/public-a')],
      edges: [edge('t1', 'a')],
    })
    const original = await startRun(workflow.id)
    failPaths.add('/public-a')
    await runExecution(original.id, { publish: () => {} })
    failPaths.delete('/public-a')

    const res = await request(app)
      .post(`/api/v1/executions/${original.id}/resume`)
      .set('Authorization', `Bearer ${pat}`)
    expect(res.status).toBe(202)
    expect(res.body.resumedFrom).toBe(original.id)
    expect(res.body.statusUrl).toBe(`/api/v1/executions/${res.body.execution.id}`)
    expect(getExecution(res.body.execution.id).resumed_from_execution_id).toBe(original.id)
  })

  it('requires the trigger scope on the public surface', async () => {
    const minted = await request(app)
      .post('/api/tokens')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'resume-readonly', scopes: ['read'] })
    const pat = minted.body.token

    const res = await request(app)
      .post(`/api/v1/executions/${uuidv4()}/resume`)
      .set('Authorization', `Bearer ${pat}`)
    expect(res.status).toBe(403)
  })

  it('404s for non-members and unknown executions', async () => {
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'resume-outsider@example.com', password: 'password123', displayName: 'Outsider' })

    const workflow = await createWorkflow({
      nodes: [node('t1', 'trigger-manual'), httpNode('a', '/member-a')],
      edges: [edge('t1', 'a')],
    })
    const execution = await startRun(workflow.id)
    failPaths.add('/member-a')
    await runExecution(execution.id, { publish: () => {} })
    failPaths.delete('/member-a')

    const foreign = await request(app)
      .post(`/api/executions/${execution.id}/resume`)
      .set('Authorization', `Bearer ${other.body.token}`)
    expect(foreign.status).toBe(404)

    const unknown = await resume(uuidv4())
    expect(unknown.status).toBe(404)
  })
})
