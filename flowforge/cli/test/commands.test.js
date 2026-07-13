const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { startStub, makeCtx } = require('./helpers')
const workflows = require('../src/commands/workflows')
const trigger = require('../src/commands/trigger')
const runs = require('../src/commands/runs')
const insights = require('../src/commands/insights')
const forecast = require('../src/commands/forecast')
const schedule = require('../src/commands/schedule')
const check = require('../src/commands/check')
const runCmd = require('../src/commands/run')
const cancel = require('../src/commands/cancel')
const resume = require('../src/commands/resume')
const login = require('../src/commands/login')
const { ApiError } = require('../src/api')

test('workflows lists id, name, and status', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(method, 'GET')
    assert.equal(url, '/api/v1/workflows')
    return {
      json: {
        workflows: [
          { id: 'wf-1', name: 'Nightly sync', status: 'deployed', updated_at: '2026-07-01' },
          { id: 'wf-2', name: 'Ad-hoc report', status: 'draft', updated_at: '2026-07-02' },
        ],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await workflows({ positionals: [], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Nightly sync/)
  assert.match(ctx.output(), /wf-2/)
  // The token rode along as a bearer header.
  assert.equal(stub.requests[0].headers.authorization, 'Bearer ffp_testtoken')
})

test('trigger POSTs the payload and idempotency key', async () => {
  const stub = await startStub(() => ({
    status: 202,
    json: {
      execution: { id: 'exec-9', workflowId: 'wf-1', status: 'pending' },
      statusUrl: '/api/v1/executions/exec-9',
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await trigger(
    { positionals: ['wf-1'], flags: { data: '{"orderId":42}', key: 'deploy-7' } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  const req = stub.requests[0]
  assert.equal(req.method, 'POST')
  assert.equal(req.path, '/api/v1/workflows/wf-1/trigger')
  assert.deepEqual(req.body, { orderId: 42 })
  assert.equal(req.headers['idempotency-key'], 'deploy-7')
  assert.match(ctx.output(), /exec-9/)
})

test('trigger rejects malformed --data without calling the API', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await trigger({ positionals: ['wf-1'], flags: { data: 'not json' } }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
})

test('trigger --watch follows the run and exits 0 on completion', async () => {
  let polls = 0
  const stub = await startStub((method, url) => {
    if (url.endsWith('/trigger')) {
      return {
        status: 202,
        json: {
          execution: { id: 'exec-w', workflowId: 'wf-1', status: 'pending' },
          statusUrl: '/api/v1/executions/exec-w',
        },
      }
    }
    polls++
    if (polls === 1) {
      return {
        json: {
          execution: { id: 'exec-w', status: 'running', startedAt: '2026-07-09T10:00:00Z' },
          steps: [
            { id: 's1', node_id: 't1', node_type: 'trigger-manual', status: 'succeeded' },
            { id: 's2', node_id: 'h1', node_type: 'action-http', status: 'running' },
          ],
        },
      }
    }
    return {
      json: {
        execution: {
          id: 'exec-w', status: 'completed',
          startedAt: '2026-07-09T10:00:00Z', finishedAt: '2026-07-09T10:00:04Z',
        },
        steps: [
          { id: 's1', node_id: 't1', node_type: 'trigger-manual', status: 'succeeded' },
          { id: 's2', node_id: 'h1', node_type: 'action-http', status: 'succeeded' },
        ],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await trigger(
    { positionals: ['wf-1'], flags: { watch: true, interval: '0.01' } },
    ctx
  )
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /h1/)
  assert.match(ctx.output(), /Run completed/)
  // The step's transition printed once per status, not once per poll.
  assert.equal(ctx.lines.filter((l) => l.includes('t1')).length, 1)
})

test('a watched run that fails exits 1', async () => {
  const stub = await startStub((method, url) => {
    if (url.endsWith('/trigger')) {
      return {
        status: 202,
        json: {
          execution: { id: 'exec-f', workflowId: 'wf-1', status: 'pending' },
          statusUrl: '/api/v1/executions/exec-f',
        },
      }
    }
    return {
      json: {
        execution: { id: 'exec-f', status: 'failed' },
        steps: [{ id: 's1', node_id: 'h1', node_type: 'action-http', status: 'failed' }],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await trigger(
    { positionals: ['wf-1'], flags: { watch: true, interval: '0.01' } },
    ctx
  )
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /Run failed/)
})

test('runs renders the summary table with a limit', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/executions?limit=2')
    return {
      json: {
        executions: [
          {
            id: 'e1', status: 'completed', triggerType: 'api',
            startedAt: '2026-07-09T10:00:00Z', finishedAt: '2026-07-09T10:00:02Z',
          },
          { id: 'e2', status: 'failed', triggerType: 'webhook', startedAt: null, finishedAt: null },
        ],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await runs({ positionals: ['wf-1'], flags: { limit: '2' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /e1/)
  assert.match(ctx.output(), /webhook/)
})

test('insights renders percentiles, success rate, and anomalies', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/insights?limit=100')
    return {
      json: {
        workflowId: 'wf-1',
        window: { limit: 100, runs: 42, since: '2026-07-01', until: '2026-07-09' },
        counts: { total: 42, completed: 38, failed: 3, cancelled: 1, running: 0 },
        successRate: 38 / 41,
        throughput: { runs: 42, spanDays: 8, perDay: 5.25 },
        duration: { count: 38, min: 900, max: 20000, mean: 1100, stdev: 200, p50: 1000, p90: 1300, p95: 1500, p99: 1900 },
        trend: { direction: 'degrading', significant: true, tau: 0.4, z: 3.1, samples: 38, method: 'mann-kendall' },
        anomalyCount: 1,
        slowestSteps: [
          { nodeId: 'http-1', nodeType: 'action-http', runs: 38, avgDurationMs: 800, maxDurationMs: 1900 },
        ],
        recentRuns: [
          { id: 'slow-1', status: 'completed', durationMs: 20000, anomalyScore: 41.2, severity: 'severe', isAnomaly: true },
          { id: 'ok-1', status: 'completed', durationMs: 1000, anomalyScore: 0.1, severity: 'normal', isAnomaly: false },
        ],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await insights({ positionals: ['wf-1'], flags: { limit: '100' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Success rate/)
  assert.match(ctx.output(), /92\.7%/) // 38/41
  assert.match(ctx.output(), /P95/)
  assert.match(ctx.output(), /1\.5s/) // p95 duration
  assert.match(ctx.output(), /action-http/)
  assert.match(ctx.output(), /slower over time/) // the degrading trend line
  assert.match(ctx.output(), /slow-1/) // the anomalous run is listed
  assert.doesNotMatch(ctx.output(), /ok-1/) // the healthy run is not
})

test('insights without a workflow id prints usage and exits 1', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await insights({ positionals: [], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
  assert.match(ctx.output(), /Usage: flowforge insights/)
})

test('insights reports an empty workflow gracefully', async () => {
  const stub = await startStub(() => ({
    json: { workflowId: 'wf-1', window: { limit: 50, runs: 0, since: null, until: null }, counts: {}, recentRuns: [] },
  }))
  const ctx = makeCtx(stub.api)
  const code = await insights({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /No runs yet/)
})

test('forecast prints the estimate, bottleneck, and coverage', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/forecast')
    return {
      json: {
        workflowId: 'wf-1',
        available: true,
        criticalPath: ['t', 'slow', 'join'],
        estimatedMs: 540,
        estimatedP95Ms: 880,
        bottleneck: { nodeId: 'slow', nodeType: 'action-http', p50: 500, p95: 800 },
        coverage: { nodesWithHistory: 2, workNodes: 3, ratio: 2 / 3 },
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await forecast({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Estimated/)
  assert.match(ctx.output(), /540ms typical/)
  assert.match(ctx.output(), /Bottleneck/)
  assert.match(ctx.output(), /slow/)
  assert.match(ctx.output(), /2\/3 nodes have history/) // 67%
})

test('forecast reports an unavailable graph', async () => {
  const stub = await startStub(() => ({ json: { workflowId: 'wf-1', available: false, reason: 'cycle' } }))
  const ctx = makeCtx(stub.api)
  const code = await forecast({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /cycle/)
})

test('forecast without a workflow id prints usage and exits 1', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await forecast({ positionals: [], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
})

test('schedule lists upcoming fire times and passes --count through', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/schedule?count=2')
    return {
      json: {
        workflowId: 'wf-1',
        scheduled: true,
        active: true,
        cron: '0 9 * * *',
        reachable: true,
        nextRuns: ['2026-01-15T09:00:00.000Z', '2026-01-16T09:00:00.000Z'],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await schedule({ positionals: ['wf-1'], flags: { count: '2' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Schedule/)
  assert.match(ctx.output(), /0 9 \* \* \*/)
  assert.match(ctx.output(), /2026-01-15 09:00 UTC/)
  assert.match(ctx.output(), /2026-01-16 09:00 UTC/)
})

test('schedule reports a workflow with no schedule trigger', async () => {
  const stub = await startStub(() => ({ json: { workflowId: 'wf-1', scheduled: false, nextRuns: [] } }))
  const ctx = makeCtx(stub.api)
  const code = await schedule({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /no schedule trigger/)
})

test('schedule warns when a valid schedule never fires', async () => {
  const stub = await startStub(() => ({
    json: { workflowId: 'wf-1', scheduled: true, active: true, cron: '0 0 30 2 *', reachable: false, nextRuns: [] },
  }))
  const ctx = makeCtx(stub.api)
  const code = await schedule({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /never fires/)
})

test('schedule without a workflow id prints usage and exits 1', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await schedule({ positionals: [], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
})

const healthyInsights = {
  workflowId: 'wf-1',
  successRate: 0.99,
  duration: { p95: 1200 },
  sla: { maxDurationMs: 5000, minSuccessRate: 0.95, durationCompliant: true, successRateCompliant: true },
  trend: { direction: 'flat', significant: false },
  anomalyCount: 0,
}

test('check passes a healthy workflow and exits 0', async () => {
  const stub = await startStub((method, url) => {
    assert.equal(url, '/api/v1/workflows/wf-1/insights')
    return { json: healthyInsights }
  })
  const ctx = makeCtx(stub.api)
  const code = await check({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /healthy/)
})

test('check fails when the SLA success floor is breached', async () => {
  const stub = await startStub(() => ({
    json: { ...healthyInsights, successRate: 0.7 },
  }))
  const ctx = makeCtx(stub.api)
  const code = await check({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.match(ctx.output(), /Success rate/)
  assert.match(ctx.output(), /failed/)
})

test('check fails on a significant degrading trend', async () => {
  const stub = await startStub(() => ({
    json: { ...healthyInsights, trend: { direction: 'degrading', significant: true } },
  }))
  const ctx = makeCtx(stub.api)
  const code = await check({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.match(ctx.output(), /Duration trend/)
})

test('check honours an explicit --max-p95 threshold', async () => {
  const stub = await startStub(() => ({ json: { ...healthyInsights, sla: null } }))
  const ctx = makeCtx(stub.api)
  // p95 is 1200ms; a 1s budget fails.
  const code = await check({ positionals: ['wf-1'], flags: { 'max-p95': '1' } }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.match(ctx.output(), /p95 duration/)
})

test('check fails on anomalies only under --strict', async () => {
  const withAnomalies = { ...healthyInsights, anomalyCount: 2 }
  const lenient = await startStub(() => ({ json: withAnomalies }))
  let ctx = makeCtx(lenient.api)
  let code = await check({ positionals: ['wf-1'], flags: {} }, ctx)
  await lenient.close()
  assert.equal(code, 0) // anomalies alone don't fail by default

  const strict = await startStub(() => ({ json: withAnomalies }))
  ctx = makeCtx(strict.api)
  code = await check({ positionals: ['wf-1'], flags: { strict: true } }, ctx)
  await strict.close()
  assert.equal(code, 1)
  assert.match(ctx.output(), /Anomalies/)
})

test('check reports nothing to gate on when there are no thresholds', async () => {
  const stub = await startStub(() => ({ json: { workflowId: 'wf-1', successRate: null, duration: {}, sla: null } }))
  const ctx = makeCtx(stub.api)
  const code = await check({ positionals: ['wf-1'], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 0)
  assert.match(ctx.output(), /No health thresholds/)
})

test('check without a workflow id prints usage and exits 1', async () => {
  const stub = await startStub(() => ({ json: {} }))
  const ctx = makeCtx(stub.api)
  const code = await check({ positionals: [], flags: {} }, ctx)
  await stub.close()
  assert.equal(code, 1)
  assert.equal(stub.requests.length, 0)
})

test('run shows steps and exits 1 for a failed run', async () => {
  const stub = await startStub(() => ({
    json: {
      execution: { id: 'e9', status: 'failed', startedAt: '2026-07-09T10:00:00Z', finishedAt: '2026-07-09T10:00:01Z' },
      steps: [
        { id: 's1', node_id: 't1', node_type: 'trigger-manual', status: 'succeeded', started_at: null, finished_at: null, error: null },
        { id: 's2', node_id: 'h1', node_type: 'action-http', status: 'failed', started_at: null, finished_at: null, error: 'HTTP 500' },
      ],
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await runCmd({ positionals: ['e9'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 1)
  assert.match(ctx.output(), /HTTP 500/)
})

test('cancel POSTs and reports the wind-down', async () => {
  const stub = await startStub(() => ({
    status: 202,
    json: { execution: { id: 'e1', status: 'running' }, cancelling: true },
  }))
  const ctx = makeCtx(stub.api)
  const code = await cancel({ positionals: ['e1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].path, '/api/v1/executions/e1/cancel')
  assert.match(ctx.output(), /winding down/)
})

test('resume POSTs and reports the continued run', async () => {
  const stub = await startStub(() => ({
    status: 202,
    json: {
      execution: { id: 'e2', workflowId: 'wf-1', status: 'pending' },
      statusUrl: '/api/v1/executions/e2',
      resumedFrom: 'e1',
    },
  }))
  const ctx = makeCtx(stub.api)
  const code = await resume({ positionals: ['e1'], flags: {} }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.equal(stub.requests[0].path, '/api/v1/executions/e1/resume')
  assert.match(ctx.output(), /Run e2 pending/)
  assert.match(ctx.output(), /continues e1/)
})

test('resume --watch polls the new run and mirrors its outcome', async () => {
  const stub = await startStub((method, url) => {
    if (url.endsWith('/resume')) {
      return {
        status: 202,
        json: {
          execution: { id: 'e2', workflowId: 'wf-1', status: 'pending' },
          statusUrl: '/api/v1/executions/e2',
          resumedFrom: 'e1',
        },
      }
    }
    return {
      json: {
        execution: { id: 'e2', status: 'completed' },
        steps: [
          { id: 's1', node_id: 't1', node_type: 'trigger-manual', status: 'reused' },
          { id: 's2', node_id: 'h1', node_type: 'action-http', status: 'succeeded' },
        ],
      },
    }
  })
  const ctx = makeCtx(stub.api)
  const code = await resume({ positionals: ['e1'], flags: { watch: true, interval: '0.01' } }, ctx)
  await stub.close()

  assert.equal(code, 0)
  assert.match(ctx.output(), /Run completed/)
})

test('API errors surface the server message', async () => {
  const stub = await startStub(() => ({ status: 404, json: { error: 'Workflow not found' } }))
  const ctx = makeCtx(stub.api)
  await assert.rejects(
    () => trigger({ positionals: ['nope'], flags: {} }, ctx),
    (err) => err instanceof ApiError && err.message === 'Workflow not found' && err.status === 404
  )
  await stub.close()
})

test('login verifies the token, writes the config file, and resolveConfig reads it back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowforge-cli-'))
  const configFile = path.join(dir, 'config.json')
  process.env.FLOWFORGE_CONFIG = configFile
  delete process.env.FLOWFORGE_URL
  delete process.env.FLOWFORGE_TOKEN
  try {
    const stub = await startStub(() => ({ json: { workflows: [{ id: 'wf-1' }] } }))
    const ctx = makeCtx(null)
    const code = await login(
      { positionals: [], flags: { url: `${stub.baseUrl}/`, token: 'ffp_fromlogin' } },
      ctx
    )
    await stub.close()

    assert.equal(code, 0)
    assert.match(ctx.output(), /1 workflow\(s\) visible/)
    const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    assert.equal(saved.url, stub.baseUrl) // trailing slash stripped
    assert.equal(saved.token, 'ffp_fromlogin')

    const { resolveConfig } = require('../src/config')
    assert.deepEqual(resolveConfig(), { baseUrl: stub.baseUrl, token: 'ffp_fromlogin' })
  } finally {
    delete process.env.FLOWFORGE_CONFIG
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
