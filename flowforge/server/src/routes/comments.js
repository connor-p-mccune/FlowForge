const express = require('express')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const auth = require('../middleware/auth')

const router = express.Router()

// A comment/reply body is short prose. Cap it like other free-text fields
// (workflow description is 2000) so a giant payload can't bloat a thread.
const MAX_CONTENT_LENGTH = 2000

// Workspace membership row (or undefined). The `role` column distinguishes the
// workspace owner from regular members, used by the resolve permission check.
function membership(workspaceId, userId) {
  return db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, userId)
}

// Resolve a comment id to the comment row + its workflow (id, workspace_id), or
// null if either is missing. Used by the reply/resolve routes, which are keyed by
// comment id and need the owning workspace to authorize and the workflow id to
// target the right Socket.io room.
function commentContext(commentId) {
  const comment = db.prepare('SELECT * FROM canvas_comments WHERE id = ?').get(commentId)
  if (!comment) return null
  const workflow = db
    .prepare('SELECT id, workspace_id FROM workflows WHERE id = ?')
    .get(comment.workflow_id)
  return workflow ? { comment, workflow } : null
}

// A single reply with its author's display name (LEFT JOIN so a deleted author
// doesn't drop the row). This is the shape sent over the wire and broadcast.
function loadReply(replyId) {
  return db
    .prepare(
      `SELECT r.id, r.comment_id, r.author_id, r.content, r.created_at,
              u.display_name AS author_name
         FROM canvas_comment_replies r
         LEFT JOIN users u ON u.id = r.author_id
        WHERE r.id = ?`
    )
    .get(replyId)
}

// A full comment: the thread anchor (with author name) plus its replies in order.
// This is the object the GET endpoint returns per thread and that comment-added
// broadcasts.
function loadComment(commentId) {
  const comment = db
    .prepare(
      `SELECT c.id, c.workflow_id, c.author_id, c.x, c.y, c.is_resolved, c.created_at,
              u.display_name AS author_name
         FROM canvas_comments c
         LEFT JOIN users u ON u.id = c.author_id
        WHERE c.id = ?`
    )
    .get(commentId)
  if (!comment) return null
  comment.replies = db
    .prepare(
      `SELECT r.id, r.comment_id, r.author_id, r.content, r.created_at,
              u.display_name AS author_name
         FROM canvas_comment_replies r
         LEFT JOIN users u ON u.id = r.author_id
        WHERE r.comment_id = ?
        ORDER BY r.created_at ASC`
    )
    .all(commentId)
  return comment
}

// Normalize + validate free-text content. Returns the trimmed string or null.
function cleanContent(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > MAX_CONTENT_LENGTH) return null
  return text
}

// GET /api/workflows/:id/comments
// All unresolved threads for a workflow, each with its replies and author display
// names. viewerIsOwner lets the client show the Resolve action on threads the
// viewer didn't author (the server still enforces it on PUT /resolve).
router.get('/workflows/:id/comments', auth, (req, res) => {
  try {
    const workflow = db
      .prepare('SELECT id, workspace_id FROM workflows WHERE id = ?')
      .get(req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const member = membership(workflow.workspace_id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Workflow not found' })

    const comments = db
      .prepare(
        `SELECT c.id, c.workflow_id, c.author_id, c.x, c.y, c.is_resolved, c.created_at,
                u.display_name AS author_name
           FROM canvas_comments c
           LEFT JOIN users u ON u.id = c.author_id
          WHERE c.workflow_id = ? AND c.is_resolved = 0
          ORDER BY c.created_at ASC`
      )
      .all(req.params.id)

    // Attach replies in one grouped query (avoids N+1 across threads).
    if (comments.length) {
      const placeholders = comments.map(() => '?').join(',')
      const replies = db
        .prepare(
          `SELECT r.id, r.comment_id, r.author_id, r.content, r.created_at,
                  u.display_name AS author_name
             FROM canvas_comment_replies r
             LEFT JOIN users u ON u.id = r.author_id
            WHERE r.comment_id IN (${placeholders})
            ORDER BY r.created_at ASC`
        )
        .all(...comments.map((c) => c.id))
      const byComment = {}
      for (const reply of replies) (byComment[reply.comment_id] ||= []).push(reply)
      for (const comment of comments) comment.replies = byComment[comment.id] || []
    }

    res.json({ comments, viewerIsOwner: member.role === 'owner' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/workflows/:id/comments  body: { x, y, content }
// Create a thread at (x, y) and its opening reply atomically, then broadcast the
// full comment to everyone viewing the workflow.
router.post('/workflows/:id/comments', auth, (req, res) => {
  try {
    const workflow = db
      .prepare('SELECT id, workspace_id FROM workflows WHERE id = ?')
      .get(req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    if (!membership(workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    const { x, y } = req.body
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: 'x and y must be numbers' })
    }
    const content = cleanContent(req.body.content)
    if (!content) return res.status(400).json({ error: 'content is required' })

    const commentId = uuidv4()
    const now = new Date().toISOString()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO canvas_comments (id, workflow_id, author_id, x, y, is_resolved, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).run(commentId, workflow.id, req.user.id, x, y, now)
      db.prepare(
        `INSERT INTO canvas_comment_replies (id, comment_id, author_id, content, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(uuidv4(), commentId, req.user.id, content, now)
    })()

    const comment = loadComment(commentId)
    const io = req.app.get('io')
    if (io) io.to(`workflow:${workflow.id}`).emit('comment-added', { comment })
    res.status(201).json({ comment })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/comments/:id/replies  body: { content }
// Append a reply to an existing thread and broadcast it.
router.post('/comments/:id/replies', auth, (req, res) => {
  try {
    const ctx = commentContext(req.params.id)
    if (!ctx) return res.status(404).json({ error: 'Comment not found' })
    if (!membership(ctx.workflow.workspace_id, req.user.id)) {
      return res.status(404).json({ error: 'Comment not found' })
    }

    const content = cleanContent(req.body.content)
    if (!content) return res.status(400).json({ error: 'content is required' })

    const replyId = uuidv4()
    db.prepare(
      `INSERT INTO canvas_comment_replies (id, comment_id, author_id, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(replyId, ctx.comment.id, req.user.id, content, new Date().toISOString())

    const reply = loadReply(replyId)
    const io = req.app.get('io')
    if (io) io.to(`workflow:${ctx.workflow.id}`).emit('comment-reply-added', { reply })
    res.status(201).json({ reply })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/comments/:id/resolve
// Mark a thread resolved (hidden from the canvas). Only the comment's author or a
// workspace owner may resolve it.
router.put('/comments/:id/resolve', auth, (req, res) => {
  try {
    const ctx = commentContext(req.params.id)
    if (!ctx) return res.status(404).json({ error: 'Comment not found' })
    const member = membership(ctx.workflow.workspace_id, req.user.id)
    if (!member) return res.status(404).json({ error: 'Comment not found' })

    const isAuthor = ctx.comment.author_id === req.user.id
    if (!isAuthor && member.role !== 'owner') {
      return res
        .status(403)
        .json({ error: 'Only the comment author or a workspace owner can resolve this comment' })
    }

    db.prepare('UPDATE canvas_comments SET is_resolved = 1 WHERE id = ?').run(ctx.comment.id)
    const io = req.app.get('io')
    if (io) io.to(`workflow:${ctx.workflow.id}`).emit('comment-resolved', { commentId: ctx.comment.id })
    res.json({ commentId: ctx.comment.id })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
