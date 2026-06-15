// Phase 9 server-side monitor. k6 only sees the HTTP layer (enqueue), so this
// captures what happens *behind* the webhook: Bull queue depth and the real
// trigger->completion latency from the executions table.
//
// It runs INSIDE the server container, which already has bull + better-sqlite3
// installed and REDIS_URL / DATABASE_PATH in its env. Copy it in and run:
//
//   docker cp load-testing/monitor.js <server-container>:/tmp/monitor.js
//   docker compose exec server node /tmp/monitor.js sample 1000     # poll loop
//   docker compose exec server node /tmp/monitor.js report <ISO>    # latency since ISO
//
// `sample` prints one CSV row per interval (queue depth + execution-status
// counts). `report` prints trigger->completion latency percentiles for every
// execution created at/after the given ISO timestamp (i.e. one test run).

const Queue = require('bull')
const Database = require('better-sqlite3')

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379'
const DB_PATH = process.env.DATABASE_PATH || '/app/data/flowforge.db'

function openDb() {
  // Read-only: never run schema/migrations, never contend with the server's writer.
  return new Database(DB_PATH, { readonly: true, fileMustExist: true })
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]
}
const round = (v) => (v == null ? null : Math.round(v))

async function sample(intervalMs) {
  const queue = new Queue('workflow-execution', REDIS_URL)
  const db = openDb()
  const execByStatus = db.prepare('SELECT status, COUNT(*) AS c FROM executions GROUP BY status')

  console.log('iso,q_waiting,q_active,q_completed,q_failed,q_delayed,exec_pending,exec_running,exec_completed,exec_failed')
  const tick = async () => {
    const c = await queue.getJobCounts()
    const m = Object.fromEntries(execByStatus.all().map((r) => [r.status, r.c]))
    console.log([
      new Date().toISOString(),
      c.waiting, c.active, c.completed, c.failed, c.delayed,
      m.pending || 0, m.running || 0, m.completed || 0, m.failed || 0,
    ].join(','))
  }
  await tick()
  const handle = setInterval(tick, intervalMs)

  const shutdown = async () => {
    clearInterval(handle)
    try { await queue.close() } catch { /* ignore */ }
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function report(sinceIso) {
  if (!sinceIso) {
    console.error('usage: node monitor.js report <ISO timestamp>')
    process.exit(1)
  }
  const db = openDb()

  const created = db.prepare('SELECT COUNT(*) AS c FROM executions WHERE created_at >= ?').get(sinceIso).c
  const byStatus = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS c FROM executions WHERE created_at >= ? GROUP BY status')
      .all(sinceIso).map((r) => [r.status, r.c])
  )

  // End-to-end latency = finished_at - created_at (created_at is stamped at
  // enqueue time in routes/webhooks.js, so this includes Bull queue wait).
  const lat = db.prepare(`
    SELECT (julianday(finished_at) - julianday(created_at)) * 86400000 AS ms
    FROM executions
    WHERE created_at >= ? AND finished_at IS NOT NULL AND status = 'completed'
    ORDER BY ms ASC
  `).all(sinceIso).map((r) => r.ms)

  // Wall-clock completion throughput: completed executions / span of their
  // finished_at timestamps.
  const span = db.prepare(`
    SELECT MIN(finished_at) AS first, MAX(finished_at) AS last, COUNT(*) AS c
    FROM executions
    WHERE created_at >= ? AND status = 'completed' AND finished_at IS NOT NULL
  `).get(sinceIso)
  let throughputPerSec = null
  if (span.c > 1 && span.first && span.last) {
    const secs = (new Date(span.last) - new Date(span.first)) / 1000
    throughputPerSec = secs > 0 ? +(span.c / secs).toFixed(2) : null
  }

  console.log(JSON.stringify({
    since: sinceIso,
    executionsCreated: created,
    byStatus,
    completed: lat.length,
    completionThroughputPerSec: throughputPerSec,
    latencyMs: {
      p50: round(percentile(lat, 50)),
      p95: round(percentile(lat, 95)),
      p99: round(percentile(lat, 99)),
      max: round(lat.length ? lat[lat.length - 1] : null),
    },
  }, null, 2))
  db.close()
}

const [, , mode, arg] = process.argv
if (mode === 'report') report(arg)
else sample(Number(arg || 1000))
