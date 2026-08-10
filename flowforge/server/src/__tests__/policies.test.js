// Policy management and admission control end to end: owner-only CRUD, the
// dry-run evaluator, and the three places a policy is felt — the deploy gate,
// the restore gate, and the Issues panel.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const request = require('supertest')

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

const { app } = require('../index')
const db = require('../config/database')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

let ownerToken
let memberToken
let outsiderToken
let workspaceId
let workflowId

const authed = (req, token = ownerToken) => req.set('Authorization', `Bearer ${token}`)

async function register(email) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName: email.split('@')[0] })
  return { token: res.body.token, userId: res.body.user.id }
}

async function setGraph(nodes, edges = []) {
  await authed(request(app).put(`/api/workflows/${workflowId}/graph`)).send({ nodes, edges })
}

async function createPolicy(body) {
  return authed(request(app).post(`/api/workspaces/${workspaceId}/policies`)).send(body)
}

const HOSTS_RULE = {
  name: 'Approved hosts',
  rule: 'len(notMatching(httpHosts, ["*.acme.com"])) == 0',
  message: 'Call an approved host.',
  evidence: 'notMatching(httpHosts, ["*.acme.com"])',
  severity: 'deny',
}

beforeAll(async () => {
  const owner = await register('policy-owner@example.com')
  ownerToken = owner.token
  const member = await register('policy-member@example.com')
  memberToken = member.token
  const outsider = await register('policy-outsider@example.com')
  outsiderToken = outsider.token

  const ws = await authed(request(app).get('/api/workspaces'))
  workspaceId = ws.body.workspaces[0].id
  await authed(request(app).post(`/api/workspaces/${workspaceId}/members`))
    .send({ email: 'policy-member@example.com', role: 'member' })

  const wf = await authed(request(app).post(`/api/workspaces/${workspaceId}/workflows`))
    .send({ name: 'Sync' })
  workflowId = wf.body.workflow.id
})

beforeEach(async () => {
  db.prepare('DELETE FROM workspace_policies WHERE workspace_id = ?').run(workspaceId)
  db.prepare("UPDATE workflows SET status = 'draft' WHERE id = ?").run(workflowId)
  await setGraph([
    node('t', 'trigger-manual'),
    node('h', 'action-http', { url: 'https://api.acme.com/orders' }),
  ], [{ id: 'e', source: 't', target: 'h' }])
})

describe('policy CRUD is owner-only', () => {
  it('creates, lists, updates, and deletes a policy', async () => {
    const created = await createPolicy(HOSTS_RULE)
    expect(created.status).toBe(201)
    expect(created.body.policy).toMatchObject({ name: 'Approved hosts', severity: 'deny', enabled: true })

    const listed = await authed(request(app).get(`/api/workspaces/${workspaceId}/policies`))
    expect(listed.body.policies).toHaveLength(1)

    const updated = await authed(
      request(app).put(`/api/workspaces/${workspaceId}/policies/${created.body.policy.id}`)
    ).send({ severity: 'warn', enabled: false })
    expect(updated.body.policy).toMatchObject({ severity: 'warn', enabled: false })
    // A partial update leaves the untouched fields alone.
    expect(updated.body.policy.rule).toBe(HOSTS_RULE.rule)

    const deleted = await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/policies/${created.body.policy.id}`)
    )
    expect(deleted.body.deleted).toBe(true)
    const after = await authed(request(app).get(`/api/workspaces/${workspaceId}/policies`))
    expect(after.body.policies).toEqual([])
  })

  it('refuses a member with 403 and a non-member with 404', async () => {
    const asMember = await authed(request(app).get(`/api/workspaces/${workspaceId}/policies`), memberToken)
    expect(asMember.status).toBe(403)
    const asOutsider = await authed(
      request(app).get(`/api/workspaces/${workspaceId}/policies`),
      outsiderToken
    )
    // A workspace's existence is not disclosed to someone outside it.
    expect(asOutsider.status).toBe(404)
  })

  it('refuses a rule that does not parse, typecheck, or name real fields', async () => {
    expect((await createPolicy({ ...HOSTS_RULE, rule: 'len(' })).status).toBe(400)
    const typo = await createPolicy({ ...HOSTS_RULE, rule: 'len(httpHost) == 0' })
    expect(typo.status).toBe(400)
    expect(typo.body.error).toMatch(/did you mean "httpHosts"/)
  })

  it('refuses a duplicate name in the same workspace', async () => {
    await createPolicy(HOSTS_RULE)
    expect((await createPolicy(HOSTS_RULE)).status).toBe(409)
  })

  it('records every change in the audit log, including the deletion', async () => {
    const created = await createPolicy(HOSTS_RULE)
    await authed(
      request(app).put(`/api/workspaces/${workspaceId}/policies/${created.body.policy.id}`)
    ).send({ enabled: false })
    await authed(
      request(app).delete(`/api/workspaces/${workspaceId}/policies/${created.body.policy.id}`)
    )

    const audit = await authed(request(app).get(`/api/workspaces/${workspaceId}/audit`))
    const actions = audit.body.entries.map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['policy.created', 'policy.updated', 'policy.deleted']))
    // Disabling is called out rather than buried in a field diff.
    const update = audit.body.entries.find((e) => e.action === 'policy.updated')
    const metadata = typeof update.metadata === 'string' ? JSON.parse(update.metadata) : update.metadata
    expect(metadata.disabled).toBe(true)
  })

  it('serves the starter library', async () => {
    const res = await authed(request(app).get('/api/policy-templates'))
    expect(res.body.templates.length).toBeGreaterThan(5)
    expect(res.body.templates[0]).toHaveProperty('rule')
  })
})

describe('the deploy gate', () => {
  it('deploys normally when nothing is declared', async () => {
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    expect(res.status).toBe(201)
  })

  it('refuses a deploy that violates a deny policy, and names the evidence', async () => {
    await createPolicy(HOSTS_RULE)
    await setGraph([node('h', 'action-http', { url: 'https://evil.example.net/x' })])

    const res = await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    // 422, not 403: the caller *is* allowed to deploy; the document is what is
    // unacceptable.
    expect(res.status).toBe(422)
    expect(res.body.violations[0]).toMatchObject({ name: 'Approved hosts', severity: 'deny' })
    expect(res.body.violations[0].evidence).toEqual(['evil.example.net'])
    expect(db.prepare('SELECT status FROM workflows WHERE id = ?').get(workflowId).status).toBe('draft')
  })

  it('lets a warn policy through', async () => {
    await createPolicy({ ...HOSTS_RULE, severity: 'warn' })
    await setGraph([node('h', 'action-http', { url: 'https://evil.example.net/x' })])
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    expect(res.status).toBe(201)
  })

  it('lets a disabled policy through', async () => {
    const created = await createPolicy(HOSTS_RULE)
    await authed(
      request(app).put(`/api/workspaces/${workspaceId}/policies/${created.body.policy.id}`)
    ).send({ enabled: false })
    await setGraph([node('h', 'action-http', { url: 'https://evil.example.net/x' })])
    expect((await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))).status).toBe(201)
  })

  it('records a blocked deploy in the activity feed', async () => {
    await createPolicy(HOSTS_RULE)
    await setGraph([node('h', 'action-http', { url: 'https://evil.example.net/x' })])
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    const feed = await authed(request(app).get(`/api/workspaces/${workspaceId}/activity`))
    expect(feed.body.activity.map((e) => e.eventType || e.event_type)).toContain('workflow.deploy_blocked')
  })
})

describe('the restore gate', () => {
  it('refuses restoring a non-compliant version onto a deployed workflow', async () => {
    // Deploy a compliant graph, then make a bad one and deploy-snapshot it by
    // deploying before the policy exists.
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    const good = await authed(request(app).get(`/api/workflows/${workflowId}/versions`))
    const goodVersionId = good.body.versions[0].id

    await setGraph([node('h', 'action-http', { url: 'https://evil.example.net/x' })])
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))

    await createPolicy(HOSTS_RULE)
    const versions = await authed(request(app).get(`/api/workflows/${workflowId}/versions`))
    const badVersionId = versions.body.versions.find((v) => v.id !== goodVersionId).id

    const res = await authed(
      request(app).post(`/api/workflows/${workflowId}/versions/${badVersionId}/restore`)
    )
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/Restore blocked/)
  })

  it('allows the same restore on a draft — nothing is running', async () => {
    await authed(request(app).post(`/api/workflows/${workflowId}/deploy`))
    const versions = await authed(request(app).get(`/api/workflows/${workflowId}/versions`))
    await createPolicy({ ...HOSTS_RULE, rule: 'false', evidence: null })
    db.prepare("UPDATE workflows SET status = 'draft' WHERE id = ?").run(workflowId)

    const res = await authed(
      request(app).post(`/api/workflows/${workflowId}/versions/${versions.body.versions[0].id}/restore`)
    )
    expect(res.status).toBe(200)
  })
})

describe('policies surface in the Issues panel', () => {
  it('reports a deny as an error and a warn as a warning, with evidence', async () => {
    await createPolicy(HOSTS_RULE)
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/lint`)).send({
      nodes: [node('h', 'action-http', { url: 'https://evil.example.net/x' })],
      edges: [],
    })
    const finding = res.body.issues.find((i) => i.code === 'policy-violation')
    expect(finding).toMatchObject({ severity: 'error', nodeId: null })
    expect(finding.message).toMatch(/Approved hosts: Call an approved host\. \(evil\.example\.net\)/)
  })

  it('judges the posted graph, so an author sees it while editing', async () => {
    await createPolicy(HOSTS_RULE)
    // The stored graph is compliant; the one on screen is not.
    const res = await authed(request(app).post(`/api/workflows/${workflowId}/lint`)).send({
      nodes: [node('h', 'action-http', { url: 'https://nope.example.net/x' })],
      edges: [],
    })
    expect(res.body.issues.some((i) => i.code === 'policy-violation')).toBe(true)

    const clean = await authed(request(app).post(`/api/workflows/${workflowId}/lint`)).send({})
    expect(clean.body.issues.some((i) => i.code === 'policy-violation')).toBe(false)
  })
})

describe('the dry-run evaluator', () => {
  it('evaluates an unsaved rule against a real workflow', async () => {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/policies/evaluate`)
    ).send({ workflowId, rule: 'len(httpHosts) == 1', evidence: 'httpHosts' })
    expect(res.body).toMatchObject({ ok: true, holds: true })
  })

  it('reports evidence when the previewed rule fails', async () => {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/policies/evaluate`)
    ).send({ workflowId, rule: 'len(httpHosts) == 0', evidence: 'httpHosts' })
    expect(res.body).toMatchObject({ ok: true, holds: false })
    expect(res.body.evidence).toEqual(['api.acme.com'])
  })

  it('returns the rule’s error as data, so the editor renders it inline', async () => {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/policies/evaluate`)
    ).send({ workflowId, rule: 'len(' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: false })
    expect(res.body.error).toMatch(/syntax error/)
  })

  it('always returns the document, because a rule is written against it', async () => {
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/policies/evaluate`)
    ).send({ workflowId })
    expect(res.body.document.httpHosts).toEqual(['api.acme.com'])
    expect(res.body.document.workflow.name).toBe('Sync')
  })

  it('reports how the stored policies judge a workflow when no rule is given', async () => {
    await createPolicy({ ...HOSTS_RULE, rule: 'false', evidence: null })
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/policies/evaluate`)
    ).send({ workflowId })
    expect(res.body.evaluated).toBe(1)
    expect(res.body.violations).toHaveLength(1)
  })
})

describe('import reports policy violations without blocking', () => {
  it('creates the draft and says what would block its deploy', async () => {
    await createPolicy(HOSTS_RULE)
    const res = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows/import`)
    ).send({
      name: 'Imported',
      graph_data: { nodes: [node('h', 'action-http', { url: 'https://evil.example.net/x' })], edges: [] },
    })
    expect(res.status).toBe(201)
    expect(res.body.workflow.status).toBe('draft')
    expect(res.body.policyViolations).toHaveLength(1)
  })
})
