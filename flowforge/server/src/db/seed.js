// Demo seed. Creates a demo user + a "Demo Workspace" with four workflows and
// ~90 days of executions/steps, so the product has realistic data to render.
// Deterministic (fixed RNG seed) and idempotent: re-running wipes and recreates
// the demo workspace.
//
// The data is shaped to *demonstrate* rather than merely to exist, because an
// empty panel teaches nothing about what a panel is for. So the runs carry:
//
//   * **recorded step outputs** — an HTTP status, a classifier's label and
//     confidence — which is what makes `flowforge query` and run assertions
//     answer anything at all. Without them the only askable questions are about
//     status and duration.
//   * **trigger payloads** with a customer and an order, so `trigger.order.total
//     > 1000` finds something and the data-subject index has an identifier to
//     key on.
//   * **a queue**. One workflow has a concurrency cap and a daily burst, so runs
//     wait before they start — which is the difference between the capacity
//     report saying "no queue to check" and showing a cap that is comfortable on
//     the average and saturated at its peak.
//   * **two pinned assertions**, whose states are computed by running the real
//     `checkRun` over the seeded history rather than written in by hand.
//
//   node src/db/seed.js
//
// Log in as demo@flowforge.dev / demo1234 to view it in the app.

const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { subjectOf } = require('../services/subjectIndex')
const runAssertions = require('../services/runAssertions')

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
  validate: [2, 12],
}
// An approval is not drawn from a range. It is however long a person takes,
// which is minutes for most and hours for a few — and that long tail is exactly
// why the capacity model uses Allen-Cunneen rather than M/M/c. A uniform sample
// here would give a service-time CV² near zero and quietly demonstrate the
// well-behaved case the model exists to say is rare.
// Mean twenty minutes, exponentially distributed. The scale is chosen so the
// cap below is genuinely contended: two slots against these arrivals is a real
// queue rather than a number nothing pushes against.
const sampleApprovalMs = () => Math.round(1_200_000 * -Math.log(1 - rand() * 0.999))

const sampleMs = (type) => {
  if (type === 'approval') return sampleApprovalMs()
  const [a, b] = NODE_MS[type] || [5, 30]
  return randInt(a, b)
}

let nodeSeq = 0
// `id` is optional and generated when absent. The refund workflow names its
// nodes, because it is the one the demo queries and assertions point at and
// `steps.refund.output.status >= 500` is a sentence where `steps.n4.…` is not.
function node(type, label, x, id, config) {
  return {
    id: id || `n${++nodeSeq}`,
    type,
    position: { x, y: 80 },
    data: { label, config: config || {} },
  }
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
    // Which trigger field says whose data a run is about
    // (services/subjectIndex.js). Only the workflows that actually receive a
    // person's details declare one; the rest have no data subject, which is the
    // normal case rather than an omission.
    subjectPath: 'customer.email',
    payload: true,
    plan: () => {
      const hot = rand() < 0.6
      return { path: [t1, c1, cond1, hot ? s1 : log1], skipped: [hot ? log1 : s1] }
    },
  }

  // 2. Daily Sales Digest (manual, linear, AI summary + email)
  nodeSeq = 0
  // A *daily* digest was triggered manually, which is the kind of thing that is
  // true of a real workspace and nobody notices. It is scheduled, and it is
  // scheduled at midnight, because that is what people pick.
  const t2 = node('trigger-schedule', 'Every night', 0, undefined, { cron: '0 0 * * *' })
  const h2 = node('action-http', 'Fetch Orders', 160, undefined, {
    method: 'GET',
    url: 'https://api.northwind.example/orders?since={{trigger.since}}',
  })
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
    schedule: { hour: 0, minute: 0 },
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
    payload: true,
    plan: () => ({ path: [t3, x3, cl3, s3], skipped: [] }),
  }

  // 4. Data Sync Job (manual, two HTTP calls around a delay)
  nodeSeq = 0
  const t4 = node('trigger-schedule', 'Nightly', 0, undefined, { cron: '0 0 * * *' })
  const h4a = node('action-http', 'Pull Source', 160, undefined, {
    method: 'GET',
    url: 'https://api.contoso.example/records',
  })
  const d4 = node('action-delay', 'Throttle', 320)
  // A POST with no idempotency key, on a workflow whose recovery policy says
  // every step is safe to repeat. That combination is not staged for the demo —
  // it is the mistake `flowforge repeats` exists to find, and an author who
  // reasoned "it is a sync, syncs are idempotent" makes it honestly.
  const h4b = node('action-http', 'Push Target', 480, undefined, {
    method: 'POST',
    url: 'https://api.fabrikam.example/records',
  })
  const log4 = node('output-log', 'Report', 640)
  const wf4 = {
    name: 'Data Sync Job',
    nodes: [t4, h4a, d4, h4b, log4],
    edges: [edge(t4.id, h4a.id), edge(h4a.id, d4.id), edge(d4.id, h4b.id), edge(h4b.id, log4.id)],
    lambda: 1.5,
    failRate: 0.12,
    schedule: { hour: 0, minute: 0 },
    recoveryPolicy: 'resume',
    plan: () => ({ path: [t4, h4a, d4, h4b, log4], skipped: [] }),
  }

  // 5. Refund Approval (webhook → validate → human approval → refund)
  //
  // The workflow with a queue, and the reason it has one is the approval: it
  // holds its execution slot for however long the person takes. A cap of two
  // against business-hours arrivals is genuinely contended, so the wait the
  // capacity report measures is *caused* by the cap rather than written into
  // the data — which is what lets the model's self-check say "agrees".
  nodeSeq = 0
  const t5 = node('trigger-webhook', 'Refund Requested', 0, 'request')
  const v5 = node('validate', 'Check Request', 160, 'validate')
  const a5 = node('approval', 'Approve Refund', 320, 'approve')
  const h5 = node('action-http', 'Issue Refund', 480, 'refund', {
    method: 'POST',
    url: 'https://api.stripe.example/refunds',
  })
  const log5 = node('output-log', 'Decline Notice', 480, 'decline')
  const wf5 = {
    name: 'Refund Approval',
    nodes: [t5, v5, a5, h5, log5],
    edges: [
      edge(t5.id, v5.id),
      edge(v5.id, a5.id),
      edge(a5.id, h5.id, 'true'),
      edge(a5.id, log5.id, 'false'),
    ],
    lambda: 65,
    failRate: 0.05,
    cap: 2,
    // Arrivals follow a working day rather than landing uniformly across it.
    diurnal: true,
    payload: true,
    subjectPath: 'customer.email',
    plan: () => {
      const approved = rand() < 0.92
      return { path: [t5, v5, a5, approved ? h5 : log5], skipped: [approved ? log5 : h5] }
    },
  }

  // 6. Notify Customer (the shared callee)
  //
  // Extracted because two workflows needed the same thing, which is how a
  // sub-workflow actually comes to exist. Its own trigger is manual — somebody
  // re-sending a notice by hand — so most of its runs arrive through callers
  // and a few do not. That split is the one the exposure report has to get
  // right: a run made on somebody else's behalf is *their* consequence, and a
  // callee that scored zero without saying why would read as harmless.
  nodeSeq = 0
  const t6 = node('trigger-manual', 'Notice Requested', 0)
  const e6 = node('action-email', 'Send Notice', 200)
  const wf6 = {
    name: 'Notify Customer',
    nodes: [t6, e6],
    edges: [edge(t6.id, e6.id)],
    lambda: 0.4,
    failRate: 0.03,
    plan: () => ({ path: [t6, e6], skipped: [] }),
  }

  // The two callers. `calls` is patched with the callee's real id once the rows
  // exist — the graph has to name a workflow that is already in the database,
  // and a seed that generated the id first would be asserting an ordering the
  // product does not have.
  const sub5 = node('sub-workflow', 'Tell the customer', 640, 'notify')
  wf5.nodes.push(sub5)
  wf5.edges.push(edge(h5.id, sub5.id))
  wf5.calls = { nodeId: sub5.id, target: 'Notify Customer' }
  const plan5 = wf5.plan
  wf5.plan = () => {
    const inner = plan5()
    // Only an approved refund notifies; a declined one takes the other branch.
    return inner.path.includes(h5)
      ? { path: [...inner.path, sub5], skipped: inner.skipped }
      : { path: inner.path, skipped: [...inner.skipped, sub5] }
  }

  // Explicit id: nodeSeq restarted for the callee above, so an auto-generated
  // one here would collide with a node this graph already has.
  const sub3 = node('sub-workflow', 'Tell the customer', 800, 'notify')
  wf3.nodes.push(sub3)
  wf3.edges.push(edge(s3.id, sub3.id))
  wf3.calls = { nodeId: sub3.id, target: 'Notify Customer' }
  wf3.plan = () => ({ path: [t3, x3, cl3, s3, sub3], skipped: [] })

  return [wf1, wf2, wf3, wf4, wf5, wf6]
}

// A plausible output for each node type. This is the difference between a demo
// where the only askable question is "did it fail" and one where
// `steps.charge.output.status >= 500` finds something.
//
// The failing step gets a 5xx rather than a generic error, because that is the
// shape of the question somebody actually asks during an incident.
function sampleOutput(type, { failing = false, nodeId = null, payload = null } = {}) {
  // The refund step records what it refunded, so an assertion can compare it
  // against the order it was for — which is the kind of property no graph
  // analysis can reach and the whole reason run assertions exist.
  if (nodeId === 'refund') {
    const total = payload?.order?.total ?? 100
    return failing
      ? { status: rand() < 0.7 ? 502 : 503, ok: false, refunded: 0 }
      : { status: 200, ok: true, refunded: Math.round(total * (0.2 + rand() * 0.8)) }
  }
  switch (type) {
    case 'action-http':
      return failing
        ? { status: rand() < 0.7 ? 502 : 503, ok: false, body: { error: 'upstream unavailable' } }
        : { status: 200, ok: true, body: { records: randInt(1, 40) } }
    case 'action-email':
      return failing
        ? { sent: false, error: 'mailbox unavailable' }
        : { sent: true, to: 'team@flowforge.dev', messageId: `m-${randInt(10000, 99999)}` }
    case 'action-slack':
      return failing ? { delivered: false, status: 429 } : { delivered: true, channel: '#sales' }
    case 'ai-classify': {
      const labels = ['hot', 'warm', 'cold']
      return { label: labels[randInt(0, labels.length - 1)], confidence: Number((0.55 + rand() * 0.44).toFixed(3)) }
    }
    case 'ai-extract':
      return { fields: { priority: rand() < 0.2 ? 'urgent' : 'normal', product: 'checkout' } }
    case 'ai-prompt':
      return { text: 'Summary generated.', tokens: randInt(180, 900) }
    case 'condition':
      return { result: rand() < 0.6 }
    case 'validate':
      return { valid: true }
    case 'approval':
      return { result: 'approved', approvedBy: 'demo@flowforge.dev' }
    case 'transform':
      return { rows: randInt(1, 25) }
    case 'action-delay':
      return { waited: true }
    case 'output-log':
      return { logged: true }
    default:
      return { ok: true }
  }
}

// A small deterministic cast, so the same person recurs across runs — which is
// what makes a data-subject request return more than one row and a query like
// `trigger.customer.email == "…"` worth running.
const CUSTOMERS = [
  { email: 'ada@northwind.example', name: 'Ada Okafor' },
  { email: 'ben@contoso.example', name: 'Ben Suarez' },
  { email: 'chi@fabrikam.example', name: 'Chi Nakamura' },
  { email: 'dara@northwind.example', name: 'Dara Whitfield' },
  { email: 'eli@contoso.example', name: 'Eli Brandt' },
]

// One in twelve orders is large, so a threshold query finds a minority rather
// than everything or nothing.
function samplePayload() {
  const customer = CUSTOMERS[randInt(0, CUSTOMERS.length - 1)]
  const large = rand() < 0.08
  return {
    customer,
    order: {
      id: `ord-${randInt(10000, 99999)}`,
      total: large ? randInt(1200, 8000) : randInt(15, 900),
      currency: 'GBP',
    },
  }
}

// A workflow's execution slots, first-come-first-served.
//
// The alternative — writing a plausible wait into each row — produces data the
// capacity model cannot explain, and its self-check correctly says so. Running
// the queue instead means the wait is *caused* by the cap, which is the only
// way a demo of a queueing model demonstrates anything.
//
// Online rather than batched, because a run's service time is not known until
// its steps are built: `take` returns when a slot frees, and the caller
// `release`s it at the instant the run actually finished. The state lives for
// the whole 90 days, so a run that starts at 17:55 and takes two hours is still
// holding its slot the next morning.
function makeSlots(cap) {
  const free = new Array(cap).fill(0)
  return function take(arrivedMs) {
    let earliest = 0
    for (let i = 1; i < free.length; i += 1) if (free[i] < free[earliest]) earliest = i
    const startedMs = Math.max(arrivedMs, free[earliest])
    return { startedMs, release: (finishedMs) => { free[earliest] = finishedMs } }
  }
}

// Relative arrival volume by hour of day (UTC), for a workflow that says its
// traffic follows one.
//
// Weighted rather than a hard window, because real traffic thins overnight
// rather than stopping — and the difference matters to the thing this data
// exists to demonstrate. A hard cutoff puts an eight-hour gap in the arrival
// stream, which sends the inter-arrival CV² into the tens; Allen-Cunneen then
// multiplies the wait by (CV²ₐ + CV²ₛ)/2 and predicts an hour where the
// simulation produced twenty minutes. The model is not wrong to be conservative
// about a stream that bursty. It is just not the shape a support queue has.
const HOURLY = [
  0.15, 0.1, 0.1, 0.1, 0.15, 0.3, // 00–05 overnight
  0.7, 1.2, 1.8, 2.2, 2.4, 2.2,   // 06–11 morning ramp and peak
  1.6, 1.9, 2.0, 1.9, 1.6, 1.2,   // 12–17 afternoon
  0.9, 0.7, 0.5, 0.4, 0.3, 0.2,   // 18–23 evening taper
]
const HOURLY_TOTAL = HOURLY.reduce((a, b) => a + b, 0)

// When a run arrives. Uniform across the day by default; drawn from the curve
// above for a workflow whose traffic follows one, which is what makes a cap
// comfortable on the weekly average and contended at eleven in the morning.
function arrivalMs(wf, dayStart, maxSec) {
  let hour = 0
  // A scheduled workflow arrives when its cron fires, give or take the few
  // seconds a tick takes to reach the queue. Drawing it from the traffic curve
  // would scatter a nightly job across the afternoon and quietly erase the
  // thing the schedule report exists to show.
  if (wf.schedule) {
    const sec = wf.schedule.hour * 3600 + wf.schedule.minute * 60 + randInt(0, 4)
    return dayStart + Math.min(sec, maxSec) * 1000 + randInt(0, 999)
  }
  if (wf.diurnal) {
    let target = rand() * HOURLY_TOTAL
    while (hour < 23 && target > HOURLY[hour]) target -= HOURLY[hour++]
  } else {
    return dayStart + randInt(0, maxSec) * 1000 + randInt(0, 999)
  }
  const sec = hour * 3600 + randInt(0, 3599)
  return dayStart + Math.min(sec, maxSec) * 1000 + randInt(0, 999)
}

// What history should say started a run. The scheduler writes 'schedule', the
// webhook route 'webhook', everything else 'manual' — and the query surfaces
// filter on it, so seeding them all as 'manual' would make a real column look
// like it never varies.
function triggerTypeOf(wf) {
  const type = wf.nodes[0].type
  if (type === 'trigger-webhook') return 'webhook'
  if (type === 'trigger-schedule') return 'schedule'
  return 'manual'
}

// Build the per-step rows for a single run, starting at startMs.
function buildSteps(plan, failed, startMs, payload = null) {
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
      rows.push({ n, status: 'skipped', startedAt: t, finishedAt: t, error: null, output: null })
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
      output: sampleOutput(n.type, { failing: isFail, nodeId: n.id, payload }),
    })
    cursor += randInt(0, 40) // small gap between steps
  }

  // Branch-skipped nodes (condition's untaken side) — recorded as skipped.
  for (const n of skipped) {
    const t = new Date(startMs).toISOString()
    // A skipped node produced nothing, and recording an output for it would be
    // inventing a value the engine never computed.
    rows.push({ n, status: 'skipped', startedAt: t, finishedAt: t, error: null, output: null })
  }

  return { rows, finishedMs: cursor }
}

// `days` bounds how much history is generated. The default is the demo's ninety;
// tests pass a smaller number, because two full-size seeds is half a minute of a
// suite for a property that a fortnight demonstrates just as well.
function seed({ days = DAYS } = {}) {
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

    // Deployed, not draft. A workspace with ninety days of history behind it
    // has deployed workflows, and three analyses read `status`: the schedule
    // report only expands crons that will actually fire, and a sub-workflow
    // call refuses a target that is not deployed.
    const insertWorkflow = db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, max_concurrent_runs,
                              subject_path, recovery_policy, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'deployed', ?, ?, ?)`
    )
    // created_at is when the run *arrived*; started_at is when a slot freed.
    // Keeping them apart is the whole reason the capacity report can check its
    // own model against a measured wait.
    const insertExecution = db.prepare(
      `INSERT INTO executions (id, workflow_id, status, triggered_by, trigger_type, subject_id,
                               trigger_data, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertStep = db.prepare(
      `INSERT INTO execution_steps (id, execution_id, node_id, node_type, status, error,
                                    output_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    let execCount = 0
    let stepCount = 0
    const workflowIds = {}
    const workflows = buildWorkflows()

    // Two passes, because a sub-workflow node has to name a workflow that is
    // already there. Every row is written first, then the call targets are
    // filled in, and only then does anything run — which is also the order the
    // product enforces: the runner refuses a target it cannot resolve.
    const createdAt = new Date(todayMidnight - days * DAY_MS).toISOString()
    for (const wf of workflows) {
      const workflowId = uuidv4()
      workflowIds[wf.name] = workflowId
      insertWorkflow.run(
        workflowId, wsId, wf.name,
        JSON.stringify({ nodes: wf.nodes, edges: wf.edges }),
        wf.cap ?? null, wf.subjectPath ?? null, wf.recoveryPolicy ?? 'safe',
        userId, createdAt, nowIso
      )
    }

    const setGraph = db.prepare('UPDATE workflows SET graph_json = ? WHERE id = ?')
    for (const wf of workflows) {
      if (!wf.calls) continue
      const target = workflowIds[wf.calls.target]
      const called = wf.nodes.find((n) => n.id === wf.calls.nodeId)
      called.data.config = { workflowId: target, workflowName: wf.calls.target }
      setGraph.run(JSON.stringify({ nodes: wf.nodes, edges: wf.edges }), workflowIds[wf.name])
    }

    const calleeByName = Object.fromEntries(workflows.map((w) => [w.name, w]))

    for (const wf of workflows) {
      const workflowId = workflowIds[wf.name]

      // Slots live for the whole 90 days, not per day: a run that starts at
      // 17:55 and takes two hours is still holding one the next morning.
      const take = wf.cap ? makeSlots(wf.cap) : null

      for (let d = days - 1; d >= 0; d--) {
        // Organic daily volume: 0.5x–1.5x lambda, with occasional quiet days.
        // A daily cron fires once a day. The organic 0.5x-1.5x spread and the
        // occasional quiet day belong to traffic somebody sends, not to a
        // timer — and a schedule that skipped Tuesdays would be a different
        // and much stranger workspace.
        let runs = wf.schedule ? 1 : Math.round(wf.lambda * (0.5 + rand()))
        if (!wf.schedule && rand() < 0.12) runs = 0

        const dayStart = todayMidnight - d * DAY_MS
        const maxSec = d === 0 ? Math.max(1, nowSecOfDay - 5) : 86399
        // Sorted, because a queue is only meaningful if arrivals are processed
        // in the order they arrived.
        const arrivals = []
        for (let r = 0; r < runs; r++) arrivals.push(arrivalMs(wf, dayStart, maxSec))
        arrivals.sort((a, b) => a - b)

        for (const arrivedMs of arrivals) {
          const slot = take ? take(arrivedMs) : null
          const startMs = slot ? slot.startedMs : arrivedMs

          const payload = wf.payload ? samplePayload() : null
          const failed = rand() < wf.failRate
          const { rows, finishedMs } = buildSteps(wf.plan(), failed, startMs, payload)
          if (slot) slot.release(finishedMs)

          const executionId = uuidv4()
          const arrivedAt = new Date(arrivedMs).toISOString()
          const startedAt = new Date(startMs).toISOString()
          const finishedAt = new Date(finishedMs).toISOString()

          insertExecution.run(
            executionId, workflowId, failed ? 'failed' : 'completed',
            userId,
            triggerTypeOf(wf),
            wf.subjectPath && payload
              ? subjectOf(wsId, wf.subjectPath, payload)
              : null,
            payload ? JSON.stringify(payload) : null,
            arrivedAt, startedAt, finishedAt
          )
          execCount++

          for (const s of rows) {
            insertStep.run(
              uuidv4(), executionId, s.n.id, s.n.type, s.status, s.error,
              s.output ? JSON.stringify(s.output) : null,
              s.startedAt, s.finishedAt
            )
            stepCount++
          }

          // A sub-workflow call is a real run of the callee, with its own row
          // pointing back at the step that made it. Seeding the parent alone
          // would leave the call tree empty and the callee looking untouched —
          // and it is the row's `parent_execution_id` that three reports read
          // to decide whose consequence a run is.
          const callStep = wf.calls && rows.find((s) => s.n.id === wf.calls.nodeId)
          if (callStep && callStep.status === 'succeeded') {
            const callee = calleeByName[wf.calls.target]
            const childStart = Date.parse(callStep.startedAt)
            const { rows: childRows } = buildSteps(callee.plan(), false, childStart, payload)
            const childId = uuidv4()
            insertExecution.run(
              childId, workflowIds[wf.calls.target], 'completed', userId, 'sub-workflow',
              null, payload ? JSON.stringify(payload) : null,
              callStep.startedAt, callStep.startedAt, callStep.finishedAt
            )
            execCount++
            for (const s of childRows) {
              insertStep.run(
                uuidv4(), childId, s.n.id, s.n.type, s.status, s.error,
                s.output ? JSON.stringify(s.output) : null,
                s.startedAt, s.finishedAt
              )
              stepCount++
            }
            // The child run is nested under the calling step.
            db.prepare('UPDATE executions SET parent_execution_id = ?, parent_node_id = ? WHERE id = ?')
              .run(executionId, wf.calls.nodeId, childId)
          }
        }
      }
    }

    // Two pinned assertions on the refund workflow, and their states are
    // *computed* rather than written in: checkRun is the same code path the
    // engine's terminal hook uses, replayed over the seeded history. A demo
    // whose panel showed a hand-written "violated" would be showing a
    // screenshot, not the feature.
    const refundId = workflowIds['Refund Approval']
    if (refundId) {
      // Both guard on the step's *status* rather than on `"refund" in steps`,
      // and the difference is the sharp edge docs/QUERY.md warns about. A
      // declined run still records a `refund` row — skipped, with no output —
      // so the membership test passes, `steps.refund.output.refunded` is
      // undefined, and FXL compares `"undefined" > "817"` as strings and calls
      // it true. Guarding on the status is the idiom, and it is the one worth
      // demonstrating.
      runAssertions.createAssertion(refundId, {
        name: 'A refund that returned a server error',
        predicate: 'steps.refund.status == "failed" and steps.refund.output.status >= 500',
        createdBy: userId,
      })
      runAssertions.createAssertion(refundId, {
        name: 'A refund larger than the order it was for',
        predicate:
          'steps.refund.status == "succeeded" and steps.refund.output.refunded > trigger.order.total',
        createdBy: userId,
      })
      const runs = db
        .prepare('SELECT id FROM executions WHERE workflow_id = ? ORDER BY created_at ASC')
        .all(refundId)
      for (const { id } of runs) runAssertions.checkRun(id, { notify: false })
    }

    return { userId, wsId, execCount, stepCount, workflowCount: workflows.length, workflowIds }
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
  const refundId = result.workflowIds['Refund Approval']
  if (refundId) {
    console.log('')
    console.log('  Things to try against "Refund Approval" (id below):')
    console.log(`    flowforge capacity ${refundId} --target 300000`)
    console.log(
      `    flowforge query ${refundId} 'steps.refund.status == "failed"' --explain`
    )
    console.log(`    flowforge assertions ${refundId}`)
    console.log(`    flowforge subject ada@northwind.example`)
  }
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
