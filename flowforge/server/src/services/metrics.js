// Minimal, dependency-free Prometheus instrumentation. Three metric kinds
// (counter, gauge, histogram) with labels, rendered in the text exposition
// format at GET /metrics. Values live in module-level maps — cheap enough to
// update on every request/run, and reset only by a process restart, exactly
// like prom-client's defaults.
//
// Kept hand-rolled on purpose: the app needs a dozen series, not a client
// library, and the exposition format is three line shapes.

const registry = [] // every metric, in registration order
const collectors = [] // async fns run at scrape time (queue depth, process stats)

// One label-set key.  can't appear in our label values, so joining on it
// is collision-free.
function labelKey(labelNames, labels) {
  return labelNames.map((n) => String(labels?.[n] ?? '')).join('')
}

function renderLabels(labelNames, key, extra = '') {
  const values = key.split('')
  const parts = labelNames.map((name, i) => {
    const escaped = values[i].replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    return `${name}="${escaped}"`
  })
  if (extra) parts.push(extra)
  return parts.length ? `{${parts.join(',')}}` : ''
}

function counter(name, help, labelNames = []) {
  const values = new Map()
  const metric = {
    name,
    help,
    type: 'counter',
    inc(labels = {}, value = 1) {
      const key = labelKey(labelNames, labels)
      values.set(key, (values.get(key) || 0) + value)
    },
    render() {
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`]
      for (const [key, value] of values) {
        lines.push(`${name}${renderLabels(labelNames, key)} ${value}`)
      }
      return lines
    },
  }
  registry.push(metric)
  return metric
}

function gauge(name, help, labelNames = []) {
  const values = new Map()
  const metric = {
    name,
    help,
    type: 'gauge',
    set(labels = {}, value = 0) {
      values.set(labelKey(labelNames, labels), value)
    },
    render() {
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`]
      for (const [key, value] of values) {
        lines.push(`${name}${renderLabels(labelNames, key)} ${value}`)
      }
      return lines
    },
  }
  registry.push(metric)
  return metric
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

function histogram(name, help, labelNames = [], buckets = DEFAULT_BUCKETS) {
  const series = new Map() // key -> { buckets: number[], sum, count }
  const metric = {
    name,
    help,
    type: 'histogram',
    observe(labels = {}, value = 0) {
      const key = labelKey(labelNames, labels)
      let s = series.get(key)
      if (!s) {
        s = { buckets: new Array(buckets.length).fill(0), sum: 0, count: 0 }
        series.set(key, s)
      }
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]) s.buckets[i]++
      }
      s.sum += value
      s.count++
    },
    render() {
      const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`]
      for (const [key, s] of series) {
        for (let i = 0; i < buckets.length; i++) {
          lines.push(
            `${name}_bucket${renderLabels(labelNames, key, `le="${buckets[i]}"`)} ${s.buckets[i]}`
          )
        }
        lines.push(`${name}_bucket${renderLabels(labelNames, key, 'le="+Inf"')} ${s.count}`)
        lines.push(`${name}_sum${renderLabels(labelNames, key)} ${s.sum}`)
        lines.push(`${name}_count${renderLabels(labelNames, key)} ${s.count}`)
      }
      return lines
    },
  }
  registry.push(metric)
  return metric
}

// Scrape-time collectors — for values that are cheaper to read on demand than
// to track incrementally (queue depth, process stats). Failures are swallowed:
// a broken collector must never take the whole scrape down.
function registerCollector(fn) {
  collectors.push(fn)
}

async function renderPrometheus() {
  for (const collect of collectors) {
    try {
      await collect()
    } catch {
      /* collector unavailable (e.g. queue not connected) — skip its gauges */
    }
  }
  return registry.flatMap((m) => m.render()).join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// The app's metrics
// ---------------------------------------------------------------------------

const httpRequests = counter(
  'flowforge_http_requests_total',
  'HTTP requests handled, by method, matched route, and status code.',
  ['method', 'route', 'status']
)

const httpDuration = histogram(
  'flowforge_http_request_duration_seconds',
  'HTTP request latency in seconds, by method and matched route.',
  ['method', 'route']
)

const executionsTotal = counter(
  'flowforge_executions_total',
  'Workflow runs finished, by terminal status. nested=true marks sub-workflow child runs.',
  ['status', 'nested']
)

const executionDuration = histogram(
  'flowforge_execution_duration_seconds',
  'Workflow run wall time in seconds, by terminal status.',
  ['status'],
  [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300]
)

const queueJobs = gauge(
  'flowforge_queue_jobs',
  'Execution queue depth by job state, sampled at scrape time.',
  ['state']
)

const processUptime = gauge('process_uptime_seconds', 'Process uptime in seconds.')
const processMemory = gauge(
  'process_resident_memory_bytes',
  'Resident set size of the Node.js process.'
)

registerCollector(() => {
  processUptime.set({}, process.uptime())
  processMemory.set({}, process.memoryUsage().rss)
})

// Express middleware: counts every response and times it against the matched
// route pattern (e.g. /api/workflows/:id), not the raw URL, so label
// cardinality stays bounded. Unmatched requests (404 catch-all) group under
// 'unmatched'.
function httpMetricsMiddleware(req, res, next) {
  const startedAt = process.hrtime.bigint()
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched'
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9
    httpRequests.inc({ method: req.method, route, status: res.statusCode })
    httpDuration.observe({ method: req.method, route }, seconds)
  })
  next()
}

// Called by the engine when a run reaches a terminal state.
function recordExecution(status, seconds, { nested = false } = {}) {
  executionsTotal.inc({ status, nested: nested ? 'true' : 'false' })
  if (Number.isFinite(seconds)) executionDuration.observe({ status }, seconds)
}

module.exports = {
  counter,
  gauge,
  histogram,
  registerCollector,
  renderPrometheus,
  httpMetricsMiddleware,
  recordExecution,
  queueJobs,
}
