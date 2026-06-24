const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { app } = require('../index')
const db = require('../config/database')

describe('canvas comments', () => {
  let ownerToken
  let ownerId
  let workspaceId
  let workflowId
  let memberToken // a regular (non-owner) member of the workspace
  let memberId
  let outsiderToken // not a member of the workspace at all

  const authed = (req, token) => req.set('Authorization', `Bearer ${token}`)
  const postComment = (token, body) =>
    authed(request(app).post(`/api/workflows/${workflowId}/comments`).send(body), token)

  beforeAll(async () => {
    const owner = await request(app)
      .post('/api/auth/register')
      .send({ email: 'owner@example.com', password: 'password123', displayName: 'Olivia Owner' })
    ownerToken = owner.body.token
    ownerId = owner.body.user.id

    const ws = await authed(request(app).get('/api/workspaces'), ownerToken)
    workspaceId = ws.body.workspaces[0].id

    const wf = await authed(
      request(app).post(`/api/workspaces/${workspaceId}/workflows`).send({ name: 'Commented Flow' }),
      ownerToken
    )
    workflowId = wf.body.workflow.id

    const member = await request(app)
      .post('/api/auth/register')
      .send({ email: 'member@example.com', password: 'password123', displayName: 'Mike Member' })
    memberToken = member.body.token
    memberId = member.body.user.id
    // Add the member to the owner's workspace as a regular (non-owner) member.
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(
      workspaceId,
      memberId
    )

    const outsider = await request(app)
      .post('/api/auth/register')
      .send({ email: 'outsider@example.com', password: 'password123', displayName: 'Oscar Outsider' })
    outsiderToken = outsider.body.token
  })

  it('creates a comment with its opening reply and the author display name', async () => {
    const res = await postComment(ownerToken, { x: 120.5, y: -40, content: 'Should this be a webhook?' })
    expect(res.status).toBe(201)
    const c = res.body.comment
    expect(c).toMatchObject({
      workflow_id: workflowId,
      author_id: ownerId,
      x: 120.5,
      y: -40,
      is_resolved: 0,
      author_name: 'Olivia Owner',
    })
    expect(c.replies).toHaveLength(1)
    expect(c.replies[0]).toMatchObject({ content: 'Should this be a webhook?', author_name: 'Olivia Owner' })
  })

  it('lists unresolved comments with replies, and flags the viewer owner', async () => {
    const res = await authed(request(app).get(`/api/workflows/${workflowId}/comments`), ownerToken)
    expect(res.status).toBe(200)
    expect(res.body.viewerIsOwner).toBe(true)
    expect(res.body.comments.length).toBeGreaterThanOrEqual(1)
    expect(res.body.comments[0].replies[0]).toHaveProperty('author_name')

    // A regular member is not flagged as an owner.
    const asMember = await authed(request(app).get(`/api/workflows/${workflowId}/comments`), memberToken)
    expect(asMember.body.viewerIsOwner).toBe(false)
  })

  it('rejects non-numeric coordinates and empty content', async () => {
    expect((await postComment(ownerToken, { x: 'a', y: 0, content: 'hi' })).status).toBe(400)
    expect((await postComment(ownerToken, { x: 0, y: 0, content: '   ' })).status).toBe(400)
  })

  it('appends replies to a thread in order', async () => {
    const created = await postComment(ownerToken, { x: 1, y: 2, content: 'first' })
    const commentId = created.body.comment.id

    const reply = await authed(
      request(app).post(`/api/comments/${commentId}/replies`).send({ content: 'a reply from a member' }),
      memberToken
    )
    expect(reply.status).toBe(201)
    expect(reply.body.reply).toMatchObject({
      comment_id: commentId,
      content: 'a reply from a member',
      author_name: 'Mike Member',
    })

    const list = await authed(request(app).get(`/api/workflows/${workflowId}/comments`), ownerToken)
    const found = list.body.comments.find((c) => c.id === commentId)
    expect(found.replies.map((r) => r.content)).toEqual(['first', 'a reply from a member'])
  })

  it('lets the author resolve a thread, which then disappears from the list', async () => {
    const created = await postComment(ownerToken, { x: 5, y: 5, content: 'resolve me' })
    const commentId = created.body.comment.id

    const res = await authed(request(app).put(`/api/comments/${commentId}/resolve`), ownerToken)
    expect(res.status).toBe(200)
    expect(res.body.commentId).toBe(commentId)

    const list = await authed(request(app).get(`/api/workflows/${workflowId}/comments`), ownerToken)
    expect(list.body.comments.find((c) => c.id === commentId)).toBeUndefined()
  })

  it("lets a workspace owner resolve another member's comment", async () => {
    const created = await postComment(memberToken, { x: 9, y: 9, content: 'member comment' })
    const res = await authed(request(app).put(`/api/comments/${created.body.comment.id}/resolve`), ownerToken)
    expect(res.status).toBe(200)
  })

  it('forbids a non-author, non-owner member from resolving (403)', async () => {
    const created = await postComment(ownerToken, { x: 3, y: 3, content: 'only owner or author' })
    const res = await authed(request(app).put(`/api/comments/${created.body.comment.id}/resolve`), memberToken)
    expect(res.status).toBe(403)
  })

  it('hides comments from non-members (404) and requires auth (401)', async () => {
    expect((await authed(request(app).get(`/api/workflows/${workflowId}/comments`), outsiderToken)).status).toBe(404)
    expect((await postComment(outsiderToken, { x: 0, y: 0, content: 'sneaky' })).status).toBe(404)
    expect((await request(app).get(`/api/workflows/${workflowId}/comments`)).status).toBe(401)
  })

  it('404s replies and resolve on an unknown comment id', async () => {
    expect(
      (await authed(request(app).post(`/api/comments/does-not-exist/replies`).send({ content: 'x' }), ownerToken))
        .status
    ).toBe(404)
    expect((await authed(request(app).put(`/api/comments/does-not-exist/resolve`), ownerToken)).status).toBe(404)
  })

  // Cross-feature wiring: a comment add/resolve must surface in the workspace
  // activity feed (the feed ships a Comments filter that's otherwise dead).
  it('records comment.added / comment.resolved in the workspace activity feed', async () => {
    const activityFor = (eventType, entityId) =>
      db
        .prepare(
          `SELECT * FROM activity_events
            WHERE workspace_id = ? AND event_type = ? AND entity_id = ?`
        )
        .get(workspaceId, eventType, entityId)

    const created = await postComment(ownerToken, { x: 7, y: 8, content: 'log me to the feed' })
    const commentId = created.body.comment.id

    const added = activityFor('comment.added', commentId)
    expect(added).toMatchObject({
      actor_id: ownerId,
      entity_type: 'comment',
      entity_name: 'Commented Flow',
    })
    expect(JSON.parse(added.metadata)).toMatchObject({ workflowId })

    await authed(request(app).put(`/api/comments/${commentId}/resolve`), ownerToken)
    const resolved = activityFor('comment.resolved', commentId)
    expect(resolved).toMatchObject({ actor_id: ownerId, entity_type: 'comment' })
    expect(JSON.parse(resolved.metadata)).toMatchObject({ workflowId })
  })
})
