// Policy as code: workspace-level rules a workflow must satisfy before it can
// go live.
//
// The linter answers "will this run?". This answers a question no amount of
// correctness checking can — **"is this allowed here?"** — and the difference
// matters as soon as more than one person builds workflows in the same place.
// A graph that calls an unapproved host, a scheduled job with no dead-man's
// switch, an AI workflow in a workspace with no spend cap, an API key typed
// into a header instead of stored as a secret: all of them lint perfectly and
// all of them are things an organisation wants to be able to say no to, once,
// rather than in code review every time.
//
// Four decisions shape it.
//
// **Policies are FXL, not a bespoke rule format.** The workspace already has a
// safe expression language with a parser, a static analyser, a type checker,
// and an inline playground; a second rules dialect would need all of that
// again and would be worse. A policy is one expression that must hold:
//
//     len(notMatching(httpHosts, ["*.acme.com", "api.stripe.com"])) == 0
//
// **The document is pre-aggregated, because FXL has no lambdas.** Rather than
// giving a rule the raw graph and no way to traverse it, `buildDocument` flattens
// a workflow into the facts policies are actually written about — the distinct
// node types, the hosts it calls, the secrets it references, its limits, what
// its workspace has configured. That is also what makes rules readable a year
// later.
//
// **A policy that cannot be evaluated fails closed.** A broken rule is not a
// pass. Rules are parsed *and type-checked against the document's schema* when
// they are saved, so a rule that throws at admission time is an anomaly rather
// than a typo — and a control that silently disables itself is worse than no
// control.
//
// **Violations name their evidence.** A policy may carry an `evidence`
// expression, evaluated only when the rule fails, whose value is reported with
// the violation: "blocked: evil.example.com" rather than "a host is not
// allowed". Without it, a policy tells you that you are wrong but not where.

const T = require('./types')
const { compile, typeCheck, analyze, ExpressionError } = require('./expression')

// — the policy document ————————————————————————————————————————————————

// Credential-shaped literals. The first group is provider prefixes, which are
// unambiguous enough to flag on sight; the second is a key whose *name* says
// credential paired with a value long enough to be one. Both skip anything
// containing a placeholder, because `{{secrets.X}}` is the very thing we want
// people doing.
const CREDENTIAL_PREFIXES = [
  'sk-', 'sk_live_', 'sk_test_', 'pk_live_', 'rk_live_',
  'ghp_', 'gho_', 'ghs_', 'github_pat_',
  'xoxb-', 'xoxp-', 'xoxa-',
  'AKIA', 'ASIA', 'AIza',
  '-----BEGIN',
]
const CREDENTIAL_KEYS = /^(?:password|passwd|token|api[-_]?key|apikey|secret|client[-_]?secret|authorization|auth|bearer|private[-_]?key)$/i
const MIN_CREDENTIAL_LENGTH = 12

function looksLikeCredential(key, value) {
  if (typeof value !== 'string') return false
  if (value.includes('{{')) return false
  const trimmed = value.trim()
  if (trimmed.length < 8) return false
  if (CREDENTIAL_PREFIXES.some((p) => trimmed.startsWith(p))) return true
  if (!CREDENTIAL_KEYS.test(String(key))) return false
  // A key called `authorization` holding "Bearer …" is the common shape.
  const payload = trimmed.replace(/^Bearer\s+/i, '')
  return payload.length >= MIN_CREDENTIAL_LENGTH && !payload.includes(' ')
}

// Node ids whose config contains something that looks like a credential typed
// in by hand. A heuristic, and named as one: it exists so a policy can say "put
// it in secrets", not to prove anything.
function scanForCredentials(nodes) {
  const flagged = new Set()
  for (const node of nodes) {
    const walk = (value, key) => {
      if (typeof value === 'string') {
        if (looksLikeCredential(key, value)) flagged.add(node.id)
        // Headers and bodies are usually JSON *strings*, so the credential is
        // one level further in than the config key suggests.
        const trimmed = value.trim()
        if (trimmed.startsWith('{')) {
          try {
            walk(JSON.parse(trimmed), key)
          } catch {
            /* not JSON — the string check above already ran */
          }
        }
      } else if (Array.isArray(value)) {
        value.forEach((v) => walk(v, key))
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, k)
      }
    }
    walk(node.data?.config || {}, null)
  }
  return [...flagged]
}

const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

function collectReferences(nodes, head) {
  const found = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) {
        const parts = match[1].split('.')
        if (parts[0] === head && parts[1]) found.add(parts[1])
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk)
    }
  }
  for (const node of nodes) walk(node.data?.config || {})
  return [...found].sort()
}

// The host part of a URL, with templated segments tolerated: a URL built from
// `{{vars.BASE}}` has no host we can name, and reporting a garbage one would be
// worse than reporting none.
function hostOf(url) {
  const text = String(url || '')
  if (text.includes('{{')) return null
  try {
    return new URL(text).host || null
  } catch {
    return null
  }
}

const unique = (values) => [...new Set(values.filter((v) => v != null && v !== ''))].sort()

// Flatten a workflow into the facts policies are written about.
//
//   workflow  the row (graph_json, limits, error_workflow_id, …)
//   context   { webhooks, testCount, workspace } — everything that lives
//             outside the row. Supplied by the caller so this stays a pure
//             function and can be unit-tested without a database.
function buildDocument(workflow, context = {}) {
  let graph = { nodes: [], edges: [] }
  try {
    const parsed = JSON.parse(workflow.graph_json || '{}')
    graph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
  } catch {
    /* an unparseable graph is an empty one for policy purposes */
  }
  // Sticky notes never execute, so they are not part of what a policy governs.
  const nodes = graph.nodes.filter((n) => n.type !== 'note')

  const configOf = (n) => n.data?.config || {}
  const ofType = (type) => nodes.filter((n) => n.type === type)

  const nodeCounts = {}
  for (const n of nodes) nodeCounts[n.type] = (nodeCounts[n.type] || 0) + 1

  const httpNodes = ofType('action-http')
  const httpUrls = unique(httpNodes.map((n) => configOf(n).url))
  const slackUrls = unique(ofType('action-slack').map((n) => configOf(n).webhookUrl))
  const outboundUrls = unique([...httpUrls, ...slackUrls])

  const scheduleNodes = ofType('trigger-schedule')
  const webhooks = context.webhooks || []

  const aiTypes = ['ai-prompt', 'ai-classify', 'ai-extract']
  const workspace = context.workspace || {}

  return {
    workflow: {
      id: workflow.id,
      name: workflow.name || '',
      description: workflow.description || '',
      status: workflow.status || 'draft',
      isDeployed: workflow.status === 'deployed',
      nodeCount: nodes.length,
      edgeCount: graph.edges.length,
    },

    // Composition.
    nodeTypes: unique(nodes.map((n) => n.type)),
    nodeCounts,
    nodeIds: nodes.map((n) => n.id),
    labels: unique(nodes.map((n) => n.data?.label)),
    triggerTypes: unique(nodes.filter((n) => n.type.startsWith('trigger-')).map((n) => n.type)),
    hasSchedule: scheduleNodes.length > 0,
    hasWebhookTrigger: ofType('trigger-webhook').length > 0,
    hasApproval: ofType('approval').length > 0,
    hasAiNode: aiTypes.some((t) => ofType(t).length > 0),
    hasSubWorkflow: ofType('sub-workflow').length > 0 || ofType('for-each').length > 0,
    hasErrorHandler: Boolean(workflow.error_workflow_id),

    // What it reaches out to.
    httpUrls,
    httpHosts: unique(httpNodes.map((n) => hostOf(configOf(n).url))),
    httpMethods: unique(httpNodes.map((n) => String(configOf(n).method || 'GET').toUpperCase())),
    outboundUrls,
    outboundHosts: unique(outboundUrls.map(hostOf)),

    // Scheduling.
    cronExpressions: unique(scheduleNodes.map((n) => configOf(n).cron)),
    timezones: unique(scheduleNodes.map((n) => configOf(n).timezone)),

    // References out of the graph.
    secretsUsed: collectReferences(nodes, 'secrets'),
    varsUsed: collectReferences(nodes, 'vars'),
    subWorkflowIds: unique(
      [...ofType('sub-workflow'), ...ofType('for-each')].map((n) => configOf(n).workflowId)
    ),

    // Node-level policies that are themselves governable.
    onErrorPolicies: unique(nodes.map((n) => configOf(n).onError || 'fail')),
    cachingNodes: nodes.filter((n) => configOf(n).cache?.enabled === true).map((n) => n.id),
    // Heuristic — a policy uses it to say "put that in secrets", not to prove
    // anything about what the string is.
    hardcodedSecrets: scanForCredentials(nodes),

    // Run limits declared on the workflow.
    limits: {
      maxConcurrentRuns: workflow.max_concurrent_runs ?? null,
      concurrencyPolicy: workflow.concurrency_policy || 'queue',
      rateLimitMax: workflow.rate_limit_max ?? null,
      rateLimitWindowSeconds: workflow.rate_limit_window_seconds ?? null,
      defaultPriority: workflow.default_priority || 'normal',
      slaMaxDurationMs: workflow.sla_max_duration_ms ?? null,
      slaMinSuccessRate: workflow.sla_min_success_rate ?? null,
      sloTarget: workflow.slo_target ?? null,
      heartbeatIntervalMinutes: workflow.heartbeat_interval_minutes ?? null,
      hasMaintenanceWindow: Boolean(workflow.maintenance_cron),
    },

    // Inbound surface.
    webhooks: {
      count: webhooks.length,
      signed: webhooks.filter((w) => Boolean(w.signing_secret)).length,
      unsigned: webhooks.filter((w) => !w.signing_secret).length,
      filtered: webhooks.filter((w) => Boolean(w.filter_expression)).length,
    },

    tests: { count: context.testCount ?? 0 },

    workspace: {
      budgetMicroUsd: workspace.budget_micro_usd ?? null,
      hasBudget: workspace.budget_micro_usd != null,
      hasStatusPage: Boolean(workspace.status_page_token),
      secretNames: (context.secretNames || []).slice().sort(),
      variableNames: (context.variableNames || []).slice().sort(),
    },
  }
}

// The document's schema, so a policy rule is type-checked when it is saved
// rather than the first time it is evaluated. Written out rather than derived
// from a sample document: a sample with no HTTP nodes would type `httpHosts` as
// `unknown[]` and lose the check that makes the rule readable.
const STRINGS = T.arrayOf(T.STRING)
const DOCUMENT_TYPE = T.objectOf({
  workflow: T.objectOf({
    id: T.STRING,
    name: T.STRING,
    description: T.STRING,
    status: T.STRING,
    isDeployed: T.BOOLEAN,
    nodeCount: T.NUMBER,
    edgeCount: T.NUMBER,
  }),
  nodeTypes: STRINGS,
  nodeCounts: T.objectOf({}, { open: true }),
  nodeIds: STRINGS,
  labels: STRINGS,
  triggerTypes: STRINGS,
  hasSchedule: T.BOOLEAN,
  hasWebhookTrigger: T.BOOLEAN,
  hasApproval: T.BOOLEAN,
  hasAiNode: T.BOOLEAN,
  hasSubWorkflow: T.BOOLEAN,
  hasErrorHandler: T.BOOLEAN,
  httpUrls: STRINGS,
  httpHosts: STRINGS,
  httpMethods: STRINGS,
  outboundUrls: STRINGS,
  outboundHosts: STRINGS,
  cronExpressions: STRINGS,
  timezones: STRINGS,
  secretsUsed: STRINGS,
  varsUsed: STRINGS,
  subWorkflowIds: STRINGS,
  onErrorPolicies: STRINGS,
  cachingNodes: STRINGS,
  hardcodedSecrets: STRINGS,
  limits: T.objectOf({
    maxConcurrentRuns: T.unionOf([T.NUMBER, T.NULL]),
    concurrencyPolicy: T.STRING,
    rateLimitMax: T.unionOf([T.NUMBER, T.NULL]),
    rateLimitWindowSeconds: T.unionOf([T.NUMBER, T.NULL]),
    defaultPriority: T.STRING,
    slaMaxDurationMs: T.unionOf([T.NUMBER, T.NULL]),
    slaMinSuccessRate: T.unionOf([T.NUMBER, T.NULL]),
    sloTarget: T.unionOf([T.NUMBER, T.NULL]),
    heartbeatIntervalMinutes: T.unionOf([T.NUMBER, T.NULL]),
    hasMaintenanceWindow: T.BOOLEAN,
  }),
  webhooks: T.objectOf({
    count: T.NUMBER,
    signed: T.NUMBER,
    unsigned: T.NUMBER,
    filtered: T.NUMBER,
  }),
  tests: T.objectOf({ count: T.NUMBER }),
  workspace: T.objectOf({
    budgetMicroUsd: T.unionOf([T.NUMBER, T.NULL]),
    hasBudget: T.BOOLEAN,
    hasStatusPage: T.BOOLEAN,
    secretNames: STRINGS,
    variableNames: STRINGS,
  }),
})

// — authoring-time validation ——————————————————————————————————————————

const SEVERITIES = ['deny', 'warn']
const MAX_RULE_LENGTH = 1000

// Check a policy's expressions before they are stored. Returns an error string
// or null. Parse errors and unknown functions are refused outright; *type*
// findings are refused too, because a rule reading `nodeCount > "5"` or
// `httpHost` (singular) would evaluate to something plausible and wrong, which
// is the one failure mode a policy must never have.
function validateRule(source, label = 'rule') {
  if (typeof source !== 'string' || source.trim() === '') return `${label} is required`
  if (source.length > MAX_RULE_LENGTH) {
    return `${label} is too long (max ${MAX_RULE_LENGTH} characters)`
  }
  const parsed = analyze(source)
  if (!parsed.ok) return `${label} has a syntax error — ${parsed.error}`
  if (parsed.unknownFunctions.length > 0) {
    return `${label} calls unknown function "${parsed.unknownFunctions[0]}()"`
  }
  const typed = typeCheck(source, DOCUMENT_TYPE)
  const fatal = typed.diagnostics.find((d) => d.severity === 'error')
  if (fatal) return `${label}: ${fatal.message}`
  return null
}

// — evaluation ————————————————————————————————————————————————————————

// Evaluate a workspace's policies against one workflow's document.
//
// Returns [{ policyId, name, severity, message, evidence }] — the ones that did
// *not* hold. A rule states the requirement, so a truthy result is compliance;
// phrasing them positively is what lets the stored `message` be the remedy
// rather than a restatement of the condition.
function evaluatePolicies(policies, document) {
  const violations = []
  for (const policy of policies) {
    if (policy.enabled === 0 || policy.enabled === false) continue
    const severity = SEVERITIES.includes(policy.severity) ? policy.severity : 'deny'
    let held
    try {
      held = compile(String(policy.rule)).evaluateBoolean(document)
    } catch (err) {
      // Fail closed. A rule is parsed and type-checked when it is saved, so
      // reaching here means something genuinely unexpected — and a control that
      // silently passes when it breaks is worse than no control at all.
      violations.push({
        policyId: policy.id,
        name: policy.name,
        severity,
        message: `Policy "${policy.name}" could not be evaluated: ${
          err instanceof ExpressionError ? err.message : 'internal error'
        }`,
        evidence: null,
        errored: true,
      })
      continue
    }
    if (held) continue

    let evidence = null
    if (policy.evidence) {
      try {
        const value = compile(String(policy.evidence)).evaluate(document)
        evidence = value === undefined ? null : value
      } catch {
        // Evidence is a courtesy; failing to compute it must not change the
        // verdict or mask the violation.
        evidence = null
      }
    }

    violations.push({
      policyId: policy.id,
      name: policy.name,
      severity,
      message: policy.message || `Policy "${policy.name}" is not satisfied`,
      evidence,
    })
  }
  return violations
}

const isBlocking = (violations) => violations.some((v) => v.severity === 'deny')

// — the starter library ————————————————————————————————————————————————
//
// Offered in the UI as one-click adds. Each is a real control someone has
// wanted, phrased as the requirement rather than the prohibition, and each
// carries the evidence expression that makes its violation actionable. They are
// *templates*, not built-ins: adding one copies it into the workspace, where it
// can be edited like any other — a policy nobody can change is a policy nobody
// trusts.
const BUILTIN_POLICIES = [
  {
    key: 'https-only',
    name: 'Outbound calls must use HTTPS',
    description: 'Every HTTP and Slack node must address an https:// URL.',
    rule: 'len(notMatching(outboundUrls, ["https://*", "{{*"])) == 0',
    message: 'This workflow calls a non-HTTPS URL. Use https:// so credentials and payloads are encrypted in transit.',
    evidence: 'notMatching(outboundUrls, ["https://*", "{{*"])',
    severity: 'deny',
  },
  {
    key: 'allowed-hosts',
    name: 'Outbound calls must target an approved host',
    description: 'Edit the list to match your approved integrations.',
    rule: 'len(notMatching(outboundHosts, ["*.example.com", "hooks.slack.com"])) == 0',
    message: 'This workflow calls a host that is not on the approved list. Add the host to the policy, or route the call through an approved gateway.',
    evidence: 'notMatching(outboundHosts, ["*.example.com", "hooks.slack.com"])',
    severity: 'deny',
  },
  {
    key: 'no-hardcoded-credentials',
    name: 'Credentials must come from secrets',
    description:
      'Flags config that looks like a literal API key, token, or password. Store it as a workspace secret and reference it as {{secrets.NAME}}.',
    rule: 'len(hardcodedSecrets) == 0',
    message: 'A node appears to contain a credential typed in directly. Move it to a workspace secret and reference it as {{secrets.NAME}} so it is encrypted at rest and redacted from run logs.',
    evidence: 'hardcodedSecrets',
    severity: 'deny',
  },
  {
    key: 'signed-webhooks',
    name: 'Webhook triggers must be signed',
    description: 'Every public trigger URL must verify an HMAC signature.',
    rule: 'webhooks.unsigned == 0',
    message: 'This workflow has an unsigned webhook trigger. Enable signing so a leaked URL alone cannot start runs.',
    evidence: 'webhooks.unsigned',
    severity: 'deny',
  },
  {
    key: 'schedule-heartbeat',
    name: 'Scheduled workflows need a heartbeat',
    description:
      'A schedule that silently stops firing produces no failed run to alert on. Declaring a heartbeat interval is what catches it.',
    rule: 'hasSchedule ? limits.heartbeatIntervalMinutes != null : true',
    message: 'This workflow runs on a schedule but declares no heartbeat interval, so nothing would notice if it stopped firing. Set one in Run limits.',
    severity: 'warn',
  },
  {
    key: 'ai-needs-budget',
    name: 'AI workflows need a spend budget',
    description: 'A workspace running AI nodes should have a monthly cap.',
    rule: 'hasAiNode ? workspace.hasBudget : true',
    message: 'This workflow calls an AI model, but its workspace has no monthly budget. Set one so a runaway loop cannot run up an unbounded bill.',
    severity: 'warn',
  },
  {
    key: 'deployed-needs-tests',
    name: 'Deployed workflows need a test scenario',
    description: 'At least one scenario, so a graph edit that breaks a contract is caught before the next run.',
    rule: 'tests.count > 0',
    message: 'This workflow has no test scenarios. Add one in the Tests panel so a future edit that breaks it fails in CI rather than at 3am.',
    severity: 'warn',
  },
  {
    key: 'error-handler',
    name: 'Deployed workflows must escalate failures',
    description: 'Designate an error-handler workflow, so a failure reaches a person.',
    rule: 'hasErrorHandler',
    message: 'This workflow designates no error handler, so a failed run notifies nobody. Set one in Run limits.',
    severity: 'warn',
  },
  {
    key: 'graph-size',
    name: 'Workflows must stay under 60 nodes',
    description: 'A graph past this size is usually several workflows wearing a trench coat.',
    rule: 'workflow.nodeCount <= 60',
    message: 'This workflow has grown past 60 nodes. Split the independent parts into sub-workflows so each piece can be tested and reused.',
    evidence: 'workflow.nodeCount',
    severity: 'warn',
  },
]

module.exports = {
  buildDocument,
  evaluatePolicies,
  validateRule,
  isBlocking,
  scanForCredentials,
  DOCUMENT_TYPE,
  BUILTIN_POLICIES,
  SEVERITIES,
  MAX_RULE_LENGTH,
}
