// Static analysis for workflow graphs. lintGraph inspects a { nodes, edges }
// canvas without running anything and returns the problems it finds, so the
// editor can surface them before a run fails at 3am.
//
// Severities:
//   error   — the run will (or almost certainly will) fail or misfire at
//             runtime: cycles, dangling edges, missing required config,
//             references that can never resolve.
//   warning — legal but probably not what the author meant: unreachable
//             branches, references that resolve to empty, half-wired
//             conditions.
//
// Each issue: { severity, code, message, nodeId } (nodeId null for
// graph-level problems). Sorted errors-first so callers can slice cheaply.

const cron = require('node-cron')
const { buildAdjacency, topoSort } = require('./dagParser')
const { analyze } = require('./expression')

const PLACEHOLDER = /\{\{\s*([\w-]+(?:\.[\w-]+)*)\s*\}\}/g

function issue(severity, code, message, nodeId = null) {
  return { severity, code, message, nodeId }
}

function label(node) {
  return node.data?.label || node.id
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '')
}

// Every {{path}} reference inside a node's config, as [firstSegment, rest].
function collectRefs(config) {
  const refs = []
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(PLACEHOLDER)) {
        const [head, ...rest] = match[1].split('.')
        refs.push({ head, rest })
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk)
    }
  }
  walk(config || {})
  return refs
}

// Per-type required-config checks. Only fields the runner will definitely
// choke on are errors; softer omissions are warnings.
function lintNodeConfig(node, { workflowTargets }) {
  const issues = []
  const config = node.data?.config || {}
  const name = label(node)

  const requireField = (field, what) => {
    if (isBlank(config[field])) {
      issues.push(
        issue('error', 'missing-config', `${name}: ${what} is required`, node.id)
      )
    }
  }

  // Static-check an FXL expression the same way the linter checks everything
  // else: a blank required field, a syntax error, or a call to a function the
  // stdlib doesn't define all fail the run, so all three are errors the author
  // can see now instead of at 3am.
  const reportExpressionIssues = (result, what) => {
    if (!result.ok) {
      issues.push(
        issue('error', 'invalid-expression', `${name}: ${what} has a syntax error — ${result.error}`, node.id)
      )
      return
    }
    for (const fn of result.unknownFunctions) {
      issues.push(
        issue('error', 'unknown-function', `${name}: ${what} calls unknown function "${fn}()"`, node.id)
      )
    }
  }
  const requireExpression = (source, what) => {
    const result = analyze(source)
    if (result.empty) {
      issues.push(issue('error', 'missing-config', `${name}: ${what} is required`, node.id))
      return
    }
    reportExpressionIssues(result, what)
  }
  // For optional FXL fields (aggregate's value / group-by): a blank field is
  // fine, but a non-blank one is still held to the same syntax/function checks.
  const optionalExpression = (source, what) => {
    if (isBlank(source)) return
    reportExpressionIssues(analyze(source), what)
  }

  switch (node.type) {
    case 'trigger-schedule':
      if (isBlank(config.cron) || !cron.validate(String(config.cron))) {
        issues.push(
          issue(
            'error',
            'invalid-cron',
            `${name}: "${config.cron ?? ''}" is not a valid cron expression`,
            node.id
          )
        )
      }
      break
    case 'action-http':
      requireField('url', 'a URL')
      break
    case 'action-email':
      requireField('to', 'a recipient')
      if (isBlank(config.subject)) {
        issues.push(
          issue('warning', 'missing-config', `${name}: the email has no subject`, node.id)
        )
      }
      break
    case 'action-slack':
      requireField('webhookUrl', 'a Slack webhook URL')
      break
    case 'ai-prompt':
      requireField('prompt', 'a prompt')
      break
    case 'ai-classify':
      requireField('text', 'input text')
      requireField('labels', 'labels')
      break
    case 'ai-extract':
      requireField('text', 'input text')
      requireField('fields', 'fields to extract')
      break
    case 'condition':
      // Expression mode is statically analysable; the simple comparison isn't
      // beyond noticing a blank left operand.
      if (config.operator === 'expression') {
        requireExpression(config.expression, 'the condition expression')
      } else if (isBlank(config.left)) {
        issues.push(
          issue(
            'warning',
            'missing-config',
            `${name}: the left value is empty — the comparison always sees ""`,
            node.id
          )
        )
      }
      break
    case 'switch': {
      // The switch routes to the first matching case's branch (or 'default').
      // Each case's label is its edge handle, so labels must be present, unique,
      // and not collide with the reserved default branch; each expression is
      // held to the same FXL syntax/function checks as a condition.
      const cases = Array.isArray(config.cases) ? config.cases : []
      if (cases.length === 0) {
        issues.push(issue('error', 'missing-config', `${name}: the switch has no cases`, node.id))
        break
      }
      const seenLabels = new Set()
      cases.forEach((c, i) => {
        const rawLabel = typeof c?.label === 'string' ? c.label.trim() : ''
        const where = rawLabel ? `case "${rawLabel}"` : `case ${i + 1}`
        if (!rawLabel) {
          issues.push(issue('error', 'missing-config', `${name}: ${where} has no label`, node.id))
        } else if (rawLabel === 'default') {
          issues.push(
            issue('error', 'invalid-config', `${name}: "default" is reserved for the fall-through branch — rename ${where}`, node.id)
          )
        } else if (seenLabels.has(rawLabel)) {
          issues.push(
            issue('error', 'invalid-config', `${name}: duplicate case label "${rawLabel}" — labels must be unique`, node.id)
          )
        } else {
          seenLabels.add(rawLabel)
        }
        requireExpression(c?.expression, `${where}'s expression`)
      })
      break
    }
    case 'validate': {
      // The Validate node needs a JSON Schema. A blank schema fails the run; a
      // non-blank one that isn't valid JSON fails it too — both catchable now.
      const raw = config.schema
      if (isBlank(raw) && !(raw && typeof raw === 'object')) {
        issues.push(issue('error', 'missing-config', `${name}: a JSON Schema is required`, node.id))
      } else if (typeof raw === 'string') {
        try {
          JSON.parse(raw)
        } catch {
          issues.push(issue('error', 'invalid-config', `${name}: the schema is not valid JSON`, node.id))
        }
      }
      break
    }
    case 'filter':
      requireExpression(config.predicate, 'the filter predicate')
      if (isBlank(config.source)) {
        issues.push(
          issue(
            'warning',
            'missing-config',
            `${name}: no source list — the filter falls back to the node input`,
            node.id
          )
        )
      }
      break
    case 'map':
      requireExpression(config.mapping, 'the map expression')
      if (isBlank(config.source)) {
        issues.push(
          issue(
            'warning',
            'missing-config',
            `${name}: no source list — the map falls back to the node input`,
            node.id
          )
        )
      }
      break
    case 'aggregate':
      // value and group-by are both optional (count-only, whole-list are valid),
      // but a non-blank one is still syntax-checked.
      optionalExpression(config.value, 'the value expression')
      optionalExpression(config.groupBy, 'the group-by expression')
      if (isBlank(config.source)) {
        issues.push(
          issue(
            'warning',
            'missing-config',
            `${name}: no source list — the aggregate falls back to the node input`,
            node.id
          )
        )
      }
      break
    case 'approval': {
      // Invalid values don't fail the run — the runner falls back to its
      // defaults — but silently waiting 60 minutes when the author typed "5m"
      // is exactly the kind of surprise a lint pass exists to catch.
      const timeout = config.timeoutMinutes
      if (!isBlank(timeout) && (!Number.isFinite(Number(timeout)) || Number(timeout) <= 0)) {
        issues.push(
          issue(
            'warning',
            'invalid-config',
            `${name}: the timeout must be a positive number of minutes — the 60-minute default applies`,
            node.id
          )
        )
      }
      if (!isBlank(config.onTimeout) && !['reject', 'fail'].includes(config.onTimeout)) {
        issues.push(
          issue(
            'warning',
            'invalid-config',
            `${name}: on-timeout must be "reject" or "fail" — defaulting to reject`,
            node.id
          )
        )
      }
      break
    }
    case 'wait-callback': {
      // Same shape as approval: bad values fall back to runner defaults, but
      // silently waiting an hour when the author typed "5m" (or taking the
      // timed-out branch when they wanted a hard failure) is lint's job to
      // surface now.
      const timeout = config.timeoutMinutes
      if (!isBlank(timeout) && (!Number.isFinite(Number(timeout)) || Number(timeout) <= 0)) {
        issues.push(
          issue(
            'warning',
            'invalid-config',
            `${name}: the timeout must be a positive number of minutes — the 60-minute default applies`,
            node.id
          )
        )
      }
      if (!isBlank(config.onTimeout) && !['continue', 'fail'].includes(config.onTimeout)) {
        issues.push(
          issue(
            'warning',
            'invalid-config',
            `${name}: on-timeout must be "continue" or "fail" — defaulting to continue`,
            node.id
          )
        )
      }
      break
    }
    case 'transform':
      if (isBlank(config.template)) {
        issues.push(
          issue('warning', 'missing-config', `${name}: the output template is empty`, node.id)
        )
      }
      break
    case 'sub-workflow':
    case 'for-each': {
      if (node.type === 'for-each') requireField('items', 'an items list')
      if (isBlank(config.workflowId)) {
        issues.push(
          issue('error', 'missing-config', `${name}: no target workflow selected`, node.id)
        )
      } else if (workflowTargets) {
        // The runner requires the target to exist in this workspace and be
        // deployed — anything else throws at run time.
        const target = workflowTargets.get(config.workflowId)
        if (!target) {
          issues.push(
            issue(
              'error',
              'missing-target',
              `${name}: the target workflow no longer exists in this workspace`,
              node.id
            )
          )
        } else if (target.status !== 'deployed') {
          issues.push(
            issue(
              'error',
              'undeployed-target',
              `${name}: target workflow "${target.name}" is not deployed`,
              node.id
            )
          )
        }
      }
      break
    }
    default:
      break
  }
  return issues
}

// Ancestor sets via a topological pass: ancestors(n) = union over incoming
// edges of source + ancestors(source). Used to tell a legal upstream reference
// from one that will always resolve empty.
function buildAncestors(order, incomingByNode) {
  const ancestors = {}
  for (const nodeId of order) {
    const set = new Set()
    for (const e of incomingByNode[nodeId] || []) {
      set.add(e.source)
      for (const a of ancestors[e.source] || []) set.add(a)
    }
    ancestors[nodeId] = set
  }
  return ancestors
}

// Lint a graph. Options (all optional — omitted context skips those rules):
//   secretNames     — Set of the workspace's secret names, for {{secrets.*}}
//   workflowTargets — Map(workflowId -> { name, status }) for sub-workflow /
//                     for-each target validation
function lintGraph({ nodes: rawNodes = [], edges: rawEdges = [] } = {}, { secretNames, workflowTargets } = {}) {
  const issues = []

  // Sticky notes are annotations: the engine drops them (and any edge touching
  // one) before building the DAG, so the linter sees exactly the graph that
  // will run — a note can't be "unreachable" or "missing config".
  const noteIds = new Set(rawNodes.filter((n) => n.type === 'note').map((n) => n.id))
  const nodes = rawNodes.filter((n) => !noteIds.has(n.id))
  const edges = rawEdges.filter((e) => !noteIds.has(e.source) && !noteIds.has(e.target))

  if (nodes.length === 0) {
    issues.push(issue('warning', 'empty-graph', 'The workflow has no nodes yet'))
    return issues
  }

  const nodeIds = new Set(nodes.map((n) => n.id))

  // Structural problems first — an edge into nowhere breaks the run before any
  // node executes, and a cycle can't be ordered at all.
  const validEdges = []
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) {
      issues.push(
        issue(
          'error',
          'dangling-edge',
          `A connection references a node that no longer exists (${e.source} → ${e.target})`
        )
      )
    } else {
      validEdges.push(e)
    }
  }

  let order = null
  try {
    const { adj, inDegree } = buildAdjacency(nodes, validEdges)
    order = topoSort(nodes, adj, inDegree)
  } catch {
    issues.push(
      issue('error', 'cycle', 'The workflow contains a cycle and can never finish')
    )
  }

  const triggers = nodes.filter((n) => n.type.startsWith('trigger-'))
  if (triggers.length === 0) {
    issues.push(
      issue(
        'warning',
        'no-trigger',
        'The workflow has no trigger node — webhooks and schedules can never start it'
      )
    )
  }

  // Nodes a trigger can never reach still execute (the engine runs the whole
  // graph), which is rarely what the author expects.
  if (triggers.length > 0 && order) {
    const reachable = new Set(triggers.map((t) => t.id))
    const outgoing = {}
    for (const e of validEdges) (outgoing[e.source] ||= []).push(e.target)
    const queue = [...reachable]
    while (queue.length) {
      for (const next of outgoing[queue.shift()] || []) {
        if (!reachable.has(next)) {
          reachable.add(next)
          queue.push(next)
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        issues.push(
          issue(
            'warning',
            'unreachable-node',
            `${label(node)} is not connected to any trigger`,
            node.id
          )
        )
      }
    }
  }

  // Branching nodes route on their source handles (condition: true/false,
  // approval: approved/rejected, wait-callback: received/timed-out); a
  // missing side means one outcome silently ends the flow.
  const BRANCH_HANDLES = {
    condition: { handles: { true: 'true', false: 'false' }, noun: 'result' },
    approval: { handles: { true: 'approved', false: 'rejected' }, noun: 'decision' },
    'wait-callback': {
      handles: { received: 'received', 'timed-out': 'timed-out' },
      noun: 'callback',
    },
  }
  for (const node of nodes) {
    const spec = BRANCH_HANDLES[node.type]
    if (!spec) continue
    // A callback gate configured to fail on timeout has no timed-out branch
    // to wire — only the received side is expected.
    const expected = Object.keys(spec.handles).filter(
      (h) =>
        !(
          node.type === 'wait-callback' &&
          h === 'timed-out' &&
          node.data?.config?.onTimeout === 'fail'
        )
    )
    const handles = new Set(
      validEdges.filter((e) => e.source === node.id).map((e) => e.sourceHandle)
    )
    const missing = expected.filter((h) => !handles.has(h))
    if (missing.length === expected.length && missing.length > 1) {
      issues.push(
        issue(
          'warning',
          'unwired-branch',
          `${label(node)}: neither branch is connected — the ${spec.noun} is never used`,
          node.id
        )
      )
    } else {
      for (const h of missing) {
        issues.push(
          issue(
            'warning',
            'unwired-branch',
            `${label(node)}: the ${spec.handles[h]} branch is not connected`,
            node.id
          )
        )
      }
    }
  }

  // Per-node error handling. The engine honors onError only on catchable
  // types (not triggers, not branching nodes) and activates an 'error' edge
  // only under the 'branch' policy — so a policy/wiring mismatch is a branch
  // that silently never runs, exactly what a lint pass exists to catch.
  const UNCATCHABLE = new Set(['condition', 'switch', 'validate', 'approval'])
  for (const node of nodes) {
    const rawPolicy = node.data?.config?.onError
    const catchable = !node.type.startsWith('trigger-') && !UNCATCHABLE.has(node.type)
    const validPolicy = rawPolicy == null || ['fail', 'continue', 'branch'].includes(rawPolicy)
    if (!validPolicy) {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: on-error must be "fail", "continue", or "branch" — defaulting to fail`,
          node.id
        )
      )
    } else if (rawPolicy && rawPolicy !== 'fail' && !catchable) {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: on-error has no effect on ${node.type} nodes — their failure always fails the run`,
          node.id
        )
      )
    }

    const policy = catchable && (rawPolicy === 'continue' || rawPolicy === 'branch') ? rawPolicy : 'fail'
    const hasErrorEdge = validEdges.some((e) => e.source === node.id && e.sourceHandle === 'error')
    if (hasErrorEdge && policy !== 'branch') {
      issues.push(
        issue(
          'error',
          'dead-error-branch',
          `${label(node)}: an error branch is wired, but on-error is "${policy}" — the branch can never run`,
          node.id
        )
      )
    } else if (policy === 'branch' && !hasErrorEdge) {
      issues.push(
        issue(
          'warning',
          'unwired-branch',
          `${label(node)}: on-error takes the error branch, but it isn't connected — a caught failure ends the flow there`,
          node.id
        )
      )
    }
  }

  // Per-node config + template references.
  const incomingByNode = {}
  for (const e of validEdges) (incomingByNode[e.target] ||= []).push(e)
  const ancestors = order ? buildAncestors(order, incomingByNode) : null

  for (const node of nodes) {
    issues.push(...lintNodeConfig(node, { workflowTargets }))

    for (const ref of collectRefs(node.data?.config)) {
      if (ref.head === 'secrets') {
        const secretName = ref.rest[0]
        if (secretNames && secretName && !secretNames.has(secretName)) {
          issues.push(
            issue(
              'error',
              'unknown-secret',
              `${label(node)}: secret "${secretName}" does not exist in this workspace`,
              node.id
            )
          )
        }
        continue
      }
      if (ref.head === 'callbacks') {
        // {{callbacks.<node-id>}} resolves to a wait-callback node's one-time
        // URL. Anything else resolves to empty at runtime — the external
        // system would be handed a blank instead of a callback address.
        const target = ref.rest[0]
        const targetNode = target ? nodes.find((n) => n.id === target) : null
        if (!targetNode || targetNode.type !== 'wait-callback') {
          issues.push(
            issue(
              'error',
              'unknown-callback-ref',
              `${label(node)}: {{callbacks.${target ?? ''}…}} doesn't reference a wait-for-callback node`,
              node.id
            )
          )
        }
        continue
      }
      if (!nodeIds.has(ref.head)) {
        issues.push(
          issue(
            'error',
            'unknown-node-ref',
            `${label(node)}: {{${ref.head}…}} references a node that doesn't exist`,
            node.id
          )
        )
      } else if (ancestors && !ancestors[node.id]?.has(ref.head)) {
        issues.push(
          issue(
            'warning',
            'non-upstream-ref',
            `${label(node)}: {{${ref.head}…}} isn't upstream of this node, so it resolves to empty`,
            node.id
          )
        )
      }
    }
  }

  const rank = { error: 0, warning: 1 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity])
}

module.exports = { lintGraph }
