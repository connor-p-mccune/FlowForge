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
const { inferGraphTypes, checkReferences } = require('./typeInference')
const { CACHEABLE_TYPES, DEFAULT_TTL_SECONDS } = require('./stepCache')
const { isEnabled: isIdempotent } = require('./stepIdempotency')
const { unresolvablePaths } = require('./redaction')
const { compensationPlan } = require('./compensation')
const { analyzeLineage } = require('./lineage')
const { guaranteeIssues } = require('./guarantees')
const { pathIssues } = require('./pathConstraints')
const { analyzeConvergence } = require('./convergence')

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

// Compensating transactions (services/compensation.js). A compensating node is
// declared, not connected, so nothing about it is structurally visible — which
// makes it precisely the kind of thing a lint pass has to guard. The failure
// mode this exists to prevent is a compensation that looks armed on the canvas
// and silently never runs: nobody notices until a run fails, and by then the
// side effect it was supposed to undo is standing in production.
//
// Every finding below is therefore an error rather than a warning when it means
// "this compensation cannot fire", and a warning only when it means "this
// compensation will fire but something around it is redundant".
function lintCompensations(plan, compensationNodes, rawEdges, rollbackPolicy) {
  const issues = []

  for (const { node, target } of plan.dangling) {
    issues.push(
      issue(
        'error',
        'dangling-compensation',
        `${label(node)}: compensates "${target}", which is not a node in this workflow`,
        node.id
      )
    )
  }

  for (const { node } of plan.invalidType) {
    issues.push(
      issue(
        'error',
        'invalid-compensation',
        `${label(node)}: a ${node.type} node cannot be a compensation — rollback follows no edges, so a trigger has nothing to emit and a branching node has nowhere to route`,
        node.id
      )
    )
  }

  for (const { node, target, winner } of plan.duplicates) {
    issues.push(
      issue(
        'error',
        'duplicate-compensation',
        `${label(node)}: "${target}" is already compensated by ${label(winner)} — a node can have only one compensation`,
        node.id
      )
    )
  }

  for (const { node, target } of plan.chained) {
    issues.push(
      issue(
        'error',
        'chained-compensation',
        `${label(node)}: compensates "${target}", which is itself a compensation — a rollback is not itself rolled back`,
        node.id
      )
    )
  }

  // Edges touching a compensation are dropped by the engine exactly like edges
  // touching a sticky note. Legal, and almost certainly a misunderstanding: the
  // author drew the undo into the flow, where it looks like it runs on the happy
  // path and does not.
  for (const node of compensationNodes) {
    const wired = rawEdges.some((e) => e.source === node.id || e.target === node.id)
    if (wired) {
      issues.push(
        issue(
          'warning',
          'wired-compensation',
          `${label(node)}: a compensation runs only during a rollback — its connections are ignored`,
          node.id
        )
      )
    }
  }

  // A workflow whose rollback policy is 'off' still renders its compensations;
  // they just never execute. That is a legitimate operational state (the kill
  // switch exists for when the compensating endpoint is the broken thing), so
  // it warns rather than errors — but silently drawing undo actions that cannot
  // run is the exact confusion this pass exists to prevent.
  if (rollbackPolicy === 'off' && plan.byTarget.size > 0) {
    issues.push(
      issue(
        'warning',
        'rollback-disabled',
        `This workflow declares ${plan.byTarget.size} compensation${plan.byTarget.size === 1 ? '' : 's'}, but its rollback policy is off — none of them will run`
      )
    )
  }

  return issues
}

// A declared approval gate — quorum, required role, separation of duties —
// against the workspace it will actually run in.
//
// The findings all have the same shape, and it is the shape a lint pass exists
// for: a gate that **cannot be satisfied** does not fail, it *waits*, until the
// timeout takes the rejected branch or fails the run. Nobody discovers a
// four-approval gate in a three-person workspace until a production run is
// stuck behind it at 3am, and by then the evidence is a timeout that looks like
// nobody was paying attention.
function lintApprovalGate(node, config, name, { approvers, hasUserTrigger }) {
  const issues = []
  const { parseGate } = require('./approvalQuorum')
  const gate = parseGate(config)

  const raw = config.quorum
  if (!isBlank(raw) && (!Number.isFinite(Number(raw)) || Number(raw) < 1)) {
    issues.push(
      issue('warning', 'invalid-config', `${name}: quorum must be a whole number of approvals ≥ 1 — one applies`, node.id)
    )
  }
  if (!isBlank(config.approverRole) && !['any', 'owner'].includes(config.approverRole)) {
    issues.push(
      issue('warning', 'invalid-config', `${name}: approver role must be "any" or "owner" — any member applies`, node.id)
    )
  }

  // The counts are only available when the linter is run against a real
  // workspace (the canvas and the deploy gate); an exported file linted without
  // one gets the config checks and nothing that would need to guess.
  if (approvers) {
    const pool = gate.requiredRole === 'owner' ? approvers.owners : approvers.members
    const who =
      gate.requiredRole === 'owner'
        ? `${pool} workspace owner${pool === 1 ? '' : 's'}`
        : `${pool} member${pool === 1 ? '' : 's'} who can approve`
    // Separation of duties removes one more person from the pool — but only on
    // a run that had a triggering user, so this is the *worst* case rather than
    // always true, which is why it is phrased as "could".
    const eligible = gate.separationOfDuties && hasUserTrigger ? pool - 1 : pool

    if (gate.quorum > pool) {
      issues.push(
        issue(
          'error',
          'unsatisfiable-approval',
          `${name}: needs ${gate.quorum} approvals but this workspace has ${who} — the gate can never pass`,
          node.id
        )
      )
    } else if (gate.quorum > eligible) {
      issues.push(
        issue(
          'error',
          'unsatisfiable-approval',
          `${name}: needs ${gate.quorum} approvals from ${who}, and separation of duties excludes whoever starts the run — a run they start can never be approved`,
          node.id
        )
      )
    }
  }

  // Nobody to exclude: a webhook delivery and a schedule tick carry no user, so
  // the rule is inert on those runs. Reported rather than silently ignored,
  // because an author who declared it believes it is protecting them.
  if (gate.separationOfDuties && hasUserTrigger === false) {
    issues.push(
      issue(
        'warning',
        'inert-config',
        `${name}: separation of duties has no effect here — this workflow has no manual trigger, and a webhook or schedule run has no user to exclude`,
        node.id
      )
    )
  }

  return issues
}

// Per-type required-config checks. Only fields the runner will definitely
// choke on are errors; softer omissions are warnings.
function lintNodeConfig(node, { workflowTargets, approvers, hasUserTrigger }) {
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
      issues.push(...lintApprovalGate(node, config, name, { approvers, hasUserTrigger }))
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
//   variableNames   — Set of the workspace's variable names, for {{vars.*}}
//   workflowTargets — Map(workflowId -> { name, status }) for sub-workflow /
//                     for-each target validation
//   resolveWorkflow — (id) => { nodes, edges } | null, so a sub-workflow node
//                     can be typed from what its target actually returns
//                     (services/graphLookup.js builds one)
//   guarantees      — the workflow's declared path invariants (raw JSON or a
//                     parsed array), verified against the graph on screen
function lintGraph({ nodes: rawNodes = [], edges: rawEdges = [] } = {}, { secretNames, variableNames, workflowTargets, resolveWorkflow, rollbackPolicy, guarantees, redact, approvers } = {}) {
  const issues = []

  // Sticky notes are annotations: the engine drops them (and any edge touching
  // one) before building the DAG, so the linter sees exactly the graph that
  // will run — a note can't be "unreachable" or "missing config".
  const noteIds = new Set(rawNodes.filter((n) => n.type === 'note').map((n) => n.id))
  const notelessNodes = rawNodes.filter((n) => !noteIds.has(n.id))

  // Compensating nodes are stripped for the same reason and by the same rule
  // the engine uses, so the structural passes below see exactly the forward
  // graph that will execute. Everything specific to them — their declarations,
  // their config, their references — is checked separately further down; what
  // they must *not* be subjected to is the structural analysis, since being
  // disconnected from every trigger is their defining property rather than a
  // defect.
  const plan = compensationPlan(notelessNodes)
  const compensationNodes = notelessNodes.filter((n) => plan.compensationIds.has(n.id))
  const nodes = notelessNodes.filter((n) => !plan.compensationIds.has(n.id))
  const edges = rawEdges.filter(
    (e) =>
      !noteIds.has(e.source) && !noteIds.has(e.target) &&
      !plan.compensationIds.has(e.source) && !plan.compensationIds.has(e.target)
  )
  issues.push(...lintCompensations(plan, compensationNodes, rawEdges, rollbackPolicy))

  if (nodes.length === 0) {
    issues.push(issue('warning', 'empty-graph', 'The workflow has no nodes yet'))
    return issues
  }

  const nodeIds = new Set(nodes.map((n) => n.id))
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]))

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

  // Declared field redaction (services/redaction.js). The values are read off
  // the *trigger payload* at run start, so a declaration whose head names a
  // node that is not a trigger can never resolve — and a redaction rule that
  // silently matches nothing is the worst possible failure here, because the
  // author believes the field is being scrubbed. An error rather than a
  // warning for exactly that reason.
  //
  // Deliberately silent about a path that simply is not in today's payload: an
  // optional field is absent on the runs that do not carry it, and reporting
  // that would make every such workflow noisy about working correctly.
  {
    const triggerIds = new Set(
      nodes.filter((n) => String(n.type || '').startsWith('trigger-')).map((n) => n.id)
    )
    for (const path of unresolvablePaths(redact, { nodeIds, triggerNodeIds: triggerIds })) {
      issues.push(
        issue(
          'error',
          'invalid-config',
          `Redaction "${path}" names a node's output, not a trigger field — it is resolved before the run and would never match`
        )
      )
    }
  }

  // Step idempotency. Only the HTTP node sends the header, so declaring it
  // anywhere else is a claim nothing acts on — and, worse, a claim the recovery
  // policy *does* act on: it would let a lost run re-execute a step on the
  // strength of a header that was never sent. Reported for that reason rather
  // than for tidiness.
  //
  // A GET is flagged separately and softly: it is already safe to repeat, so the
  // declaration is redundant rather than wrong, and the nudge is aimed at
  // somebody who ticked it on the wrong node.
  for (const node of nodes) {
    if (!isIdempotent(node)) continue
    if (node.type !== 'action-http') {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: only HTTP nodes send an idempotency key — declaring one on a ${node.type} node claims a safety the run cannot provide`,
          node.id
        )
      )
      continue
    }
    const method = String(node.data?.config?.method || 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: a ${method} is already safe to repeat — an idempotency key changes nothing here`,
          node.id
        )
      )
    }
  }

  // Step caching. The engine honors config.cache only on cacheable node types
  // (stepCache.CACHEABLE_TYPES), so caching enabled anywhere else is config
  // that silently does nothing. On an HTTP node, caching a non-GET request is
  // legal — the author is declaring the call idempotent — but worth a nudge:
  // a hit within the TTL skips the request entirely, so a cached POST doesn't
  // post.
  for (const node of nodes) {
    const cache = node.data?.config?.cache
    if (!cache || typeof cache !== 'object' || cache.enabled !== true) continue
    if (!CACHEABLE_TYPES.has(node.type)) {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: caching has no effect on ${node.type} nodes — the output is never reused`,
          node.id
        )
      )
      continue
    }
    if (node.type === 'action-http') {
      const method = String(node.data?.config?.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        issues.push(
          issue(
            'warning',
            'cached-side-effect',
            `${label(node)}: caches a ${method} request — a repeat within the TTL reuses the recorded response and never calls the API`,
            node.id
          )
        )
      }
    }
    const ttl = cache.ttlSeconds
    if (ttl != null && ttl !== '' && (!Number.isFinite(Number(ttl)) || Number(ttl) <= 0)) {
      issues.push(
        issue(
          'warning',
          'invalid-config',
          `${label(node)}: the cache TTL must be a positive number of seconds — the ${DEFAULT_TTL_SECONDS}-second default applies`,
          node.id
        )
      )
    }
  }

  // Per-node config + template references.
  const incomingByNode = {}
  for (const e of validEdges) (incomingByNode[e.target] ||= []).push(e)
  const ancestors = order ? buildAncestors(order, incomingByNode) : null

  // Compensating nodes are linted for config and references alongside the
  // forward graph — they are real nodes with real runners, and a refund with no
  // URL is as broken as any other HTTP node. Two rules differ for them, both
  // flowing from the same fact: a compensation runs *after* the run, outside
  // the DAG.
  //
  //   * The whole graph is in scope. There is no "upstream" of a node that has
  //     no incoming edges, and the engine really does resolve a compensation's
  //     templates against every node that ran — so the non-upstream warning is
  //     not merely suppressed here, it would be wrong.
  //   * `{{rollback.*}}` resolves: the failure that caused the unwind.
  const ROLLBACK_SCOPE = new Set([
    'executionId', 'workflowId', 'failedNode', 'failedNodeLabel', 'error', 'reason',
  ])

  // Can a run of this workflow have a triggering user at all? A manual trigger
  // means yes; a graph with only webhook and schedule triggers means the runs it
  // is *drawn* for do not, which is what makes a separation-of-duties
  // declaration inert. (An API trigger does carry its token's owner, so this is
  // a warning rather than a certainty — see lintApprovalGate.)
  const hasUserTrigger = nodes.some((n) => n.type === 'trigger-manual')

  for (const node of [...nodes, ...compensationNodes]) {
    const isCompensation = plan.compensationIds.has(node.id)
    issues.push(...lintNodeConfig(node, { workflowTargets, approvers, hasUserTrigger }))

    for (const ref of collectRefs(node.data?.config)) {
      if (ref.head === 'rollback') {
        if (!isCompensation) {
          issues.push(
            issue(
              'error',
              'rollback-scope-ref',
              `${label(node)}: {{rollback.…}} is only in scope inside a compensating node`,
              node.id
            )
          )
        } else if (ref.rest[0] && !ROLLBACK_SCOPE.has(ref.rest[0])) {
          issues.push(
            issue(
              'error',
              'rollback-scope-ref',
              `${label(node)}: {{rollback.${ref.rest[0]}}} doesn't exist — the rollback scope holds ${[...ROLLBACK_SCOPE].join(', ')}`,
              node.id
            )
          )
        }
        continue
      }
      // A forward node cannot read a compensation's output: the compensation
      // did not run, and by the time it does this node has already finished.
      if (plan.compensationIds.has(ref.head) && !isCompensation) {
        issues.push(
          issue(
            'error',
            'compensation-ref',
            `${label(node)}: {{${ref.head}…}} is a compensation — it produces nothing during the run`,
            node.id
          )
        )
        continue
      }
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
      if (ref.head === 'vars') {
        // {{vars.NAME}} resolves against the workspace's variables — a name
        // that doesn't exist resolves to empty at runtime, exactly like an
        // unknown secret, and is just as certainly a typo.
        const varName = ref.rest[0]
        if (variableNames && varName && !variableNames.has(varName)) {
          issues.push(
            issue(
              'error',
              'unknown-variable',
              `${label(node)}: variable "${varName}" does not exist in this workspace`,
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
      } else if (isCompensation) {
        // Every node in the forward graph is legitimately in scope — see above.
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

  // Type analysis. Everything above reasons about the graph's *structure* and
  // each node's config in isolation; this reasons about the data flowing
  // between them (services/typeInference.js) and reports the two classes only a
  // schema can see: a `{{node.field}}` that cannot resolve, and an FXL
  // expression that doesn't typecheck against what its scope actually holds.
  //
  // Deliberately last and deliberately additive. It never re-reports anything
  // the passes above own — a syntax error, an unknown function, a reference to
  // a node that doesn't exist — and it stays silent about every value it cannot
  // prove the shape of, so a graph full of dynamic webhook payloads lints
  // exactly as it did before this existed.
  const typing = inferGraphTypes({ nodes, edges: validEdges }, { resolveWorkflow })

  // Compensating nodes can't be *inferred* — they have no upstream to infer an
  // input from — but they read the outputs of nodes that were just typed, so
  // their references get the same check against the same table. Without this a
  // typo'd `{{charge-card.chrgId}}` inside a refund would be the one reference
  // in the product nobody checks, in the node where being wrong costs the most.
  for (const node of compensationNodes) {
    checkReferences(node, { outputs: typing.outputs, nodeIds, diagnostics: typing.diagnostics })
  }

  for (const finding of typing.diagnostics) {
    issues.push(
      issue(
        finding.severity,
        finding.code,
        finding.code === 'unknown-field'
          ? finding.message
          : `${label(nodeById[finding.nodeId] || { id: finding.nodeId })}: ${finding.message}`,
        finding.nodeId
      )
    )
  }

  // Dataflow analysis (services/lineage.js). The passes above reason about
  // structure, config, and the *shape* of what flows between nodes; this
  // reasons about where that data came from and where it ends up, which is the
  // only way to see the two problems it reports: a caller-controlled value
  // deciding where a request goes, and a node computing something nobody reads.
  //
  // Additive and quiet by construction, like the type pass: every finding is a
  // warning (a webhook that carries its own reply-to URL is a real and correct
  // pattern), and a sink built from authored config, a variable, or a secret
  // reports nothing at all.
  try {
    issues.push(...analyzeLineage({ nodes: rawNodes, edges: rawEdges }).findings)
  } catch (err) {
    // Lineage is an extra lens, never a gate: a graph the linter could
    // otherwise report on must not go unlinted because this pass tripped.
    console.error(`Lineage analysis failed: ${err.message}`)
  }

  // Declared path invariants (services/guarantees.js). Every pass above reasons
  // about what is *on* the canvas; this one reasons about what the canvas
  // permits, and reports only against statements the author wrote down
  // themselves — so a workflow with no declarations is completely unaffected.
  //
  // Errors rather than warnings, uniquely among the additive passes, and the
  // asymmetry is the point: a lineage finding says "this pattern is often a
  // mistake", while a violated guarantee says "the thing you told us must never
  // happen can now happen". The author already decided it mattered.
  try {
    issues.push(...guaranteeIssues({ nodes: rawNodes, edges: rawEdges }, guarantees))
  } catch (err) {
    console.error(`Guarantee verification failed: ${err.message}`)
  }

  // Path feasibility (services/pathConstraints.js). The last additive pass, and
  // the only one that reasons about the *data* rather than the graph: a branch
  // whose conditions cannot all hold at once is wired, typed, reachable and
  // dead, and every pass above it says so is fine.
  //
  // An error, like a guarantee violation, because it is not a matter of taste —
  // either the branch or the condition above it is wrong. And it inherits the
  // solver's one-sided honesty: a truncated search reports nothing, so the
  // failure mode is a missing finding rather than a wrong one.
  try {
    issues.push(...pathIssues({ nodes: rawNodes, edges: rawEdges }))
  } catch (err) {
    console.error(`Path feasibility analysis failed: ${err.message}`)
  }

  // Converging branches (services/convergence.js). Every pass above reasons
  // about one node's config or about the graph's shape; this one reasons about
  // what happens when several branches arrive at the same node and their
  // outputs are assigned over each other.
  //
  // Reported only where the *graph* does not decide it. Two contributors at
  // different dataflow depths are settled — the deeper one ran later and saw
  // the shallower one's value, and a reader can predict that from the canvas.
  // Two at the same depth are genuinely concurrent, so the canonical edge sort
  // breaks the tie alphabetically, which is deterministic and is not an opinion
  // about the workflow. Only a human can say which branch should win.
  //
  // A warning, not an error: two branches converging on a shared field is a
  // legitimate shape when the author knows one of them supersedes the other.
  // The finding says the graph does not record which.
  try {
    const report = analyzeConvergence({ nodes: rawNodes, edges: rawEdges }, { resolveWorkflow })
    for (const join of report.joins || []) {
      for (const found of join.collisions) {
        if (found.resolution !== 'tie-break') continue
        const names = found.contributors.map((c) => c.label).join(' and ')
        const winner = found.contributors.find((c) => c.nodeId === found.decidedBy)
        issues.push(
          issue(
            'warning',
            'converging-field',
            `${join.label}: ${names} both supply "${found.key}", and nothing in the graph says ` +
              `which should win` +
              (winner ? ` — ${winner.label} does, on alphabetical order alone` : '') +
              (found.sameType ? '' : `. They are differently shaped`),
            join.nodeId
          )
        )
      }
    }
  } catch (err) {
    console.error(`Convergence analysis failed: ${err.message}`)
  }

  const rank = { error: 0, warning: 1 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity])
}

module.exports = { lintGraph }
