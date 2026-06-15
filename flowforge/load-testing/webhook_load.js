// Phase 9 load test — exercises the FlowForge execution pipeline end to end:
//   POST /api/webhooks/:key  ->  Bull enqueue  ->  worker  ->  SQLite logging
//
// setup() (runs once) provisions a deliberately CHEAP workflow so the test
// stresses the pipeline itself, not external egress:
//
//   trigger-webhook  ->  action-delay (DELAY_MS)  ->  output-log
//
// The default VU loop then floods that workflow's webhook while k6 ramps the
// virtual-user count up. Run it via the official k6 image on the compose
// network so it can reach the server by service name (see load-testing/README.md):
//
//   docker run --rm --network flowforge_default \
//     -v "$PWD/load-testing":/scripts -e BASE_URL=http://server:3001 \
//     grafana/k6 run /scripts/webhook_load.js
//
// Tunables (all via -e KEY=VALUE):
//   BASE_URL   default http://server:3001
//   VUS        peak virtual users                 default 80
//   RAMP       time to ramp 1 -> VUS               default 120s
//   HOLD       hold at VUS                         default 30s
//   DELAY_MS   delay-node duration per execution   default 150
//   SLEEP_MS   per-iteration pacing per VU         default 0 (flood)

import http from 'k6/http'
import { check, fail, sleep } from 'k6'
import { Counter, Trend } from 'k6/metrics'

const BASE = __ENV.BASE_URL || 'http://server:3001'
const VUS = Number(__ENV.VUS || 80)
const DELAY_MS = Number(__ENV.DELAY_MS || 150)
const SLEEP_MS = Number(__ENV.SLEEP_MS || 0)

// Custom metrics so the run summary spells out the pipeline-specific numbers.
const accepted = new Counter('webhook_accepted_202')
const rateLimited = new Counter('webhook_rate_limited_429')
const triggerLatency = new Trend('webhook_trigger_ms', true)

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP || '120s', target: VUS },
        { duration: __ENV.HOLD || '30s', target: VUS },
      ],
      gracefulStop: '10s',
    },
  },
  // Visibility only — these never abort the run; the real analysis is the
  // custom metrics above plus the server-side monitor.js.
  thresholds: {
    http_req_failed: ['rate<1.0'],
    webhook_trigger_ms: ['p(95)<60000'],
  },
}

function buildGraph(delayMs) {
  const nodes = [
    { id: 'trigger', type: 'trigger-webhook', position: { x: 0, y: 0 }, data: { label: 'Webhook', config: {} } },
    { id: 'delay', type: 'action-delay', position: { x: 200, y: 0 }, data: { label: 'Delay', config: { durationMs: delayMs } } },
    { id: 'log', type: 'output-log', position: { x: 400, y: 0 }, data: { label: 'Log', config: {} } },
  ]
  const edges = [
    { id: 'e1', source: 'trigger', target: 'delay' },
    { id: 'e2', source: 'delay', target: 'log' },
  ]
  return { nodes, edges }
}

export function setup() {
  const json = { headers: { 'Content-Type': 'application/json' } }

  // Unique email per run so repeated runs don't 409 on a taken address.
  // (Auth limiter is raised in the loadtest compose override so this never 429s.)
  const email = `loadtest+${Date.now()}@flowforge.dev`
  const reg = http.post(`${BASE}/api/auth/register`,
    JSON.stringify({ email, password: 'loadtest1234', displayName: 'Load Test' }), json)
  if (!check(reg, { 'register 201': (r) => r.status === 201 })) {
    fail(`register failed: ${reg.status} ${reg.body}`)
  }
  const token = reg.json('token')
  const auth = { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }

  // register auto-creates a workspace; grab it.
  const ws = http.get(`${BASE}/api/workspaces`, auth)
  const wsId = ws.json().workspaces[0].id

  const wf = http.post(`${BASE}/api/workspaces/${wsId}/workflows`,
    JSON.stringify({ name: 'LoadTest webhook->delay->log' }), auth)
  if (!check(wf, { 'workflow 201': (r) => r.status === 201 })) {
    fail(`create workflow failed: ${wf.status} ${wf.body}`)
  }
  const wfId = wf.json().workflow.id

  const g = http.put(`${BASE}/api/workflows/${wfId}/graph`,
    JSON.stringify(buildGraph(DELAY_MS)), auth)
  if (!check(g, { 'graph 200': (r) => r.status === 200 })) {
    fail(`set graph failed: ${g.status} ${g.body}`)
  }

  const wh = http.post(`${BASE}/api/workflows/${wfId}/webhooks`,
    JSON.stringify({ name: 'loadtest' }), auth)
  if (!check(wh, { 'webhook 201': (r) => r.status === 201 })) {
    fail(`create webhook failed: ${wh.status} ${wh.body}`)
  }
  const key = wh.json().webhook.webhook_key

  console.log(`setup: workflow=${wfId} delayMs=${DELAY_MS} webhookKey=${key.slice(0, 8)}...`)
  return { key, wfId }
}

export default function (data) {
  const res = http.post(`${BASE}/api/webhooks/${data.key}`,
    JSON.stringify({ ts: Date.now(), vu: __VU }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'webhook_trigger' } })

  triggerLatency.add(res.timings.duration)
  if (res.status === 202) accepted.add(1)
  else if (res.status === 429) rateLimited.add(1)

  check(res, {
    'accepted 202': (r) => r.status === 202,
    'not 5xx': (r) => r.status < 500,
  })

  if (SLEEP_MS > 0) sleep(SLEEP_MS / 1000)
}
