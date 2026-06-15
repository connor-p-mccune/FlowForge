// Demo seed for the analytics dashboard (Phase 8). Creates a demo user + a
// "Demo Workspace" with four workflows and ~90 days of executions/steps so the
// dashboard has realistic data to render. Deterministic (fixed RNG seed) and
// idempotent: re-running wipes and recreates the demo workspace.
//
//   node src/db/seed.js
//
// Log in as demo@flowforge.dev / demo1234 to view it in the app.

const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')

const DEMO_EMAIL = 'demo@flowforge.dev'
const DEMO_PASSWORD = 'demo1234'
const DEMO_NAME = 'Demo User'
const DAYS = 90
const DAY_MS = 86400000

// Deterministic PRNG so the seed produces the same dashboard every run.
function mulberry32(seed) {
  return function rand() {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260614)
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1))

// Typical [min, max] duration in ms for each node type — shapes node-usage timing
// and overall execution duration.
const NODE_MS = {
  'trigger-manual': [1, 4],
  'trigger-webhook': [1, 4],
  'action-http': [120, 420],
  'action-email': [180, 520],
  'action-slack': [140, 360],
  'action-delay': [1000, 3200],
  transform: [2, 16],
  condition: [1, 6],
  'ai-prompt': [780, 1900],
  'ai-classify': [380, 1050],
  'ai-extract': [520, 1280],
  'output-log': [1, 5],
}
const sampleMs = (type) => {
  const [a, b] = NODE_MS[type] || [5, 30]
  return randInt(a, b)
}

let nodeSeq = 0
function node(type, label, x) {
  return { id: `n${++nodeSeq}`, type, position: { x, y: 80 }, data: { label, config: {} } }
}
function edge(source, target, sourceHandle) {
  const e = { id: `e-${source}-${target}`, source, target }
  if (sourceHandle) e.sourceHandle = sourceHandle
  return e
}

// --- Workflow definitions -------------------------------------------------
// Each has nodes, edges, a daily run rate (lambda), a failure rate, and a
// plan(run) that returns the executed node path + branch-skipped nodes.

function buildWorkflows() {
  // 1. Lead Capture → Slack (webhook, branches on a hot-lead condition)
  nodeSeq = 0
  const t1 = node('trigger-webhook', 'New Lead', 0)
  const c1 = node('ai-classify', 'Classify Intent', 200)
  const cond1 = node('condition', 'Hot Lead?', 400)
  const s1 = node('action-slack', 'Notify Sales', 600)
  const log1 = node('output-log', 'Log Lead', 600)
  const wf1 = {
    name: 'Lead Capture → Slack',
    nodes: [t1, c1, cond1, s1, log1],
    edges: [edge(t1.id, c1.id), edge(c1.id, cond1.id), edge(cond1.id, s1.id, 'true'), edge(cond1.id, log1.id, 'false')],
    lambda: 3,
    failRate: 0.1,
    plan: () => {
      const hot = rand() < 0.6
      return { path: [t1, c1, cond1, hot ? s1 : log1], skipped: [hot ? log1 : s1] }
    },
  }

  // 2. Daily Sales Digest (manual, linear, AI summary + email)
  nodeSeq = 0
  const t2 = node('trigger-manual', 'Run Digest', 0)
  const h2 = node('action-http', 'Fetch Orders', 160)
  const tr2 = node('transform', 'Shape Data', 320)
  const ai2 = node('ai-prompt', 'Write Summary', 480)
  const e2 = node('action-email', 'Email Team', 640)
  const log2 = node('output-log', 'Archive', 800)
  const wf2 = {
    name: 'Daily Sales Digest',
    nodes: [t2, h2, tr2, ai2, e2, log2],
    edges: [edge(t2.id, h2.id), edge(h2.id, tr2.id), edge(tr2.id, ai2.id), edge(ai2.id, e2.id), edge(e2.id, log2.id)],
    lambda: 1,
    failRate: 0.08,
    plan: () => ({ path: [t2, h2, tr2, ai2, e2, log2], skipped: [] }),
  }

  // 3. Support Ticket Router (webhook, AI extract + classify)
  nodeSeq = 0
  const t3 = node('trigger-webhook', 'New Ticket', 0)
  const x3 = node('ai-extract', 'Extract Fields', 200)
  const cl3 = node('ai-classify', 'Categorize', 400)
  const s3 = node('action-slack', 'Route to Team', 600)
  const wf3 = {
    name: 'Support Ticket Router',
    nodes: [t3, x3, cl3, s3],
    edges: [edge(t3.id, x3.id), edge(x3.id, cl3.id), edge(cl3.id, s3.id)],
    lambda: 2,
    failRate: 0.14,
    plan: () => ({ path: [t3, x3, cl3, s3], skipped: [] }),
  }

  // 4. Data Sync Job (manual, two HTTP calls around a delay)
  nodeSeq = 0
  const t4 = node('trigger-manual', 'Start Sync', 0)
  const h4a = node('action-http', 'Pull Source', 160)
  const d4 = node('action-delay', 'Throttle', 320)
  const h4b = node('action-http', 'Push Target', 480)
  const log4 = node('output-log', 'Report', 640)
  const wf4 = {
    name: 'Data Sync Job',
    nodes: [t4, h4a, d4, h4b, log4],
    edges: [edge(t4.id, h4a.id), edge(h4a.id, d4.id), edge(d4.id, h4b.id), edge(h4b.id, log4.id)],
    lambda: 1.5,
    failRate: 0.12,
    plan: () => ({ path: [t4, h4a, d4, h4b, log4], skipped: [] }),
  }

  return [wf1, wf2, wf3, wf4]
}

// Build the per-step rows for a single run, starting at startMs.
function buildSteps(plan, failed, startMs) {
  const { path, skipped } = plan
  const rows = []
  let cursor = startMs

  // Fail at a random non-trigger node in the path.
  let failIndex = -1
  if (failed) {
    const candidates = path.map((n, i) => i).filter((i) => !path[i].type.startsWith('trigger-'))
    failIndex = candidates.length ? candidates[Math.floor(rand() * candidates.length)] : path.length - 1
  }

  for (let i = 0; i < path.length; i++) {
    const n = path[i]
    if (failed && i > failIndex) {
      const t = new Date(cursor).toISOString()
      rows.push({ n, status: 'skipped', startedAt: t, finishedAt: t, error: null })
      continue
    }
    const startedAt = new Date(cursor).toISOString()
    cursor += sampleMs(n.type)
    const finishedAt = new Date(cursor).toISOString()
    const isFail = failed && i === failIndex
    rows.push({
      n,
      status: isFail ? 'failed' : 'succeeded',
      startedAt,
      finishedAt,
      error: isFail ? 'Simulated failure (seed data)' : null,
    })
    cursor += randInt(0, 40) // small gap between steps
  }

  // Branch-skipped nodes (condition's untaken side) — recorded as skipped.
  for (const n of skipped) {
    const t = new Date(startMs).toISOString()
    rows.push({ n, status: 'skipped', startedAt: t, finishedAt: t, error: null })
  }

  return { rows, finishedMs: cursor }
}

function seed() {
  const now = Date.now()
  const todayMidnight = Date.UTC(
    new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()
  )
  const nowSecOfDay = Math.floor((now - todayMidnight) / 1000)

  const run = db.transaction(() => {
    // Wipe any previous demo data (workspace cascade clears workflows/executions/steps/members).
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL)
    if (existing) {
      db.prepare('DELETE FROM workspaces WHERE created_by = ?').run(existing.id)
      db.prepare('DELETE FROM workspace_members WHERE user_id = ?').run(existing.id)
      db.prepare('DELETE FROM users WHERE id = ?').run(existing.id)
    }

    const userId = uuidv4()
    const wsId = uuidv4()
    const nowIso = new Date(now).toISOString()
    db.prepare(
      'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, DEMO_EMAIL, bcrypt.hashSync(DEMO_PASSWORD, 10), DEMO_NAME, nowIso)
    db.prepare(
      'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(wsId, 'Demo Workspace', userId, nowIso, nowIso)
    db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(wsId, userId, 'owner', nowIso)

    const insertWorkflow = db.prepare(
      'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertExecution = db.prepare(
      'INSERT INTO executions (id, workflow_id, status, triggered_by, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertStep = db.prepare(
      'INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )

    let execCount = 0
    let stepCount = 0
    const workflows = buildWorkflows()

    for (const wf of workflows) {
      const workflowId = uuidv4()
      const createdAt = new Date(todayMidnight - DAYS * DAY_MS).toISOString()
      insertWorkflow.run(
        workflowId, wsId, wf.name,
        JSON.stringify({ nodes: wf.nodes, edges: wf.edges }),
        userId, createdAt, nowIso
      )

      for (let d = DAYS - 1; d >= 0; d--) {
        // Organic daily volume: 0.5x–1.5x lambda, with occasional quiet days.
        let runs = Math.round(wf.lambda * (0.5 + rand()))
        if (rand() < 0.12) runs = 0

        for (let r = 0; r < runs; r++) {
          const dayStart = todayMidnight - d * DAY_MS
          const maxSec = d === 0 ? Math.max(1, nowSecOfDay - 5) : 86399
          const startMs = dayStart + randInt(0, maxSec) * 1000 + randInt(0, 999)

          const failed = rand() < wf.failRate
          const { rows, finishedMs } = buildSteps(wf.plan(), failed, startMs)

          const executionId = uuidv4()
          const startedAt = new Date(startMs).toISOString()
          const finishedAt = new Date(finishedMs).toISOString()
          insertExecution.run(
            executionId, workflowId, failed ? 'failed' : 'completed',
            userId, startedAt, finishedAt, startedAt
          )
          execCount++

          for (const s of rows) {
            insertStep.run(
              uuidv4(), executionId, s.n.id, s.n.type, s.status, s.error, s.startedAt, s.finishedAt
            )
            stepCount++
          }
        }
      }
    }

    return { userId, wsId, execCount, stepCount, workflowCount: workflows.length }
  })

  return run()
}

if (require.main === module) {
  const result = seed()
  console.log('Seed complete:')
  console.log(`  workspace : ${result.wsId}`)
  console.log(`  workflows : ${result.workflowCount}`)
  console.log(`  executions: ${result.execCount}`)
  console.log(`  steps     : ${result.stepCount}`)
  console.log(`  login     : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`)
  if (process.env.JWT_SECRET) {
    const token = jwt.sign(
      { id: result.userId, email: DEMO_EMAIL, displayName: DEMO_NAME },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    )
    console.log(`  token     : ${token}`)
  }
}

module.exports = { seed, DEMO_EMAIL, DEMO_PASSWORD }
