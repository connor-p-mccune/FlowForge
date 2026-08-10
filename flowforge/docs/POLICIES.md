# Workspace policies

The linter answers **"will this run?"**. A policy answers a question no amount
of correctness checking can: **"is this allowed here?"**

```
Deploy blocked by workspace policy

  Approved hosts — This workflow calls a host that is not on the approved list.
                   Add the host to the policy, or route the call through an
                   approved gateway. (evil.example.net)
```

A graph that calls an unapproved host, a scheduled job with no dead-man's
switch, an AI workflow in a workspace with no spend cap, an API key typed into a
header instead of stored as a secret — all of them lint perfectly, and all of
them are things an organisation wants to be able to say no to *once*, rather
than in code review every time.

- [Writing a policy](#writing-a-policy)
- [Where policies are checked](#where-policies-are-checked)
- [The policy document](#the-policy-document)
- [The starter library](#the-starter-library)
- [Design notes](#design-notes)

---

## Writing a policy

A policy is one [FXL](./EXPRESSIONS.md) expression that **must hold** for a
workflow to comply, plus the message shown to whoever it blocks.

| Field | |
|---|---|
| **Rule** | An expression over the [policy document](#the-policy-document). Truthy = compliant. |
| **Message** | What the author is told. Phrase it as the remedy, not a restatement of the rule. |
| **Evidence** | *Optional.* A second expression, evaluated **only when the rule fails**, whose value is reported with the violation. |
| **Severity** | `deny` refuses the deploy; `warn` records the finding and lets it through. |

```
Rule      len(notMatching(httpHosts, ["*.acme.com", "api.stripe.com"])) == 0
Message   Route this call through an approved host.
Evidence  notMatching(httpHosts, ["*.acme.com", "api.stripe.com"])
Severity  deny
```

Rules are phrased **positively** — as the requirement — which is what lets the
message be a remedy instead of a negation. Conditional requirements read
naturally with a ternary:

```
hasSchedule ? limits.heartbeatIntervalMinutes != null : true
hasAiNode ? workspace.hasBudget : true
```

Policies are managed by **workspace owners** (like secrets and status pages),
under **Policies** in the sidebar. The editor evaluates a draft rule against a
real workflow before you save it, so you can see what it would block.

Rules are validated when they are saved: they must parse, call only stdlib
functions, and **type-check against the document's schema**. A rule reading
`httpHost` (singular) is refused with a suggestion rather than stored — it would
otherwise evaluate to `undefined` and report every workflow compliant forever.

---

## Where policies are checked

| Point | Behaviour |
|---|---|
| **Deploy** | Enforced. A `deny` refuses with `422` and the violations. |
| **Version restore** onto a *deployed* workflow | Enforced — it publishes a graph without touching the deploy button. |
| **Version restore** onto a draft | Not checked. Nothing is running. |
| **Import** | Reported, not enforced (`policyViolations`, `policyBlocked`). |
| **Lint / the Issues panel** | Reported, judged against the graph on screen. |
| **Runs** | Not gated. |

**Deploy is the enforcement point** because it is the moment a workflow becomes
something the organisation runs. The refusal is `422`, not `403`: the caller *is*
allowed to deploy — the document is what is unacceptable.

**Import reports rather than blocks** because an import lands as a draft, so
nothing that runs has changed, and refusing it would keep a non-compliant
definition permanently out of the environment where someone could fix it. A
promotion pipeline keys on `policyBlocked` at the import step instead.

**Runs are not gated.** A policy governs what may be *published*; blocking an
already-deployed workflow's runs would turn a governance edit into an outage.
The pause switch and the budget exist for stopping traffic.

One limit is worth stating rather than glossing: saving the canvas of a deployed
workflow does change what runs. Blocking every save would make the canvas
unusable, so that path is covered by the Issues panel rather than by refusal.

---

## The policy document

Because FXL has no lambdas — deliberately; closures are what would let an
expression reach the host — a rule can't traverse a raw graph. Instead a
workflow is flattened into the facts policies are actually written about. Every
name below is available directly in a rule.

### Composition

| | |
|---|---|
| `workflow.name` `.description` `.status` `.isDeployed` `.nodeCount` `.edgeCount` | |
| `nodeTypes` | distinct node types, sorted — `"approval" in nodeTypes` |
| `nodeCounts` | type → count — `get(nodeCounts, "action-http", 0) < 5` |
| `nodeIds` · `labels` · `triggerTypes` | |
| `hasSchedule` `hasWebhookTrigger` `hasApproval` `hasAiNode` `hasSubWorkflow` `hasErrorHandler` | booleans |

### What it reaches out to

| | |
|---|---|
| `httpUrls` · `httpHosts` · `httpMethods` | from HTTP nodes |
| `outboundUrls` · `outboundHosts` | HTTP **and** Slack |
| `cronExpressions` · `timezones` | from schedule triggers |

A URL built from a template (`{{vars.BASE}}/orders`) contributes **no host**:
naming a garbage one would be worse than naming none.

### References and node-level settings

`secretsUsed` · `varsUsed` · `subWorkflowIds` · `onErrorPolicies` ·
`cachingNodes` · `hardcodedSecrets`

`hardcodedSecrets` is the node ids whose config contains something that *looks
like* a credential typed in by hand — a provider-prefixed literal (`sk-…`,
`ghp_…`, `xoxb-…`, `AKIA…`), or a credential-shaped key holding a long literal
value. Anything containing `{{` is skipped, because `{{secrets.X}}` is precisely
the behaviour being asked for. It is a heuristic, and it exists so a policy can
say "put that in secrets" — not to prove anything about what the string is.

### Limits and workspace settings

| | |
|---|---|
| `limits.maxConcurrentRuns` `.concurrencyPolicy` `.rateLimitMax` `.rateLimitWindowSeconds` | |
| `limits.defaultPriority` `.slaMaxDurationMs` `.slaMinSuccessRate` `.sloTarget` | |
| `limits.heartbeatIntervalMinutes` `.hasMaintenanceWindow` | |
| `webhooks.count` `.signed` `.unsigned` `.filtered` | |
| `tests.count` | test scenarios |
| `workspace.hasBudget` `.budgetMicroUsd` `.hasStatusPage` `.secretNames` `.variableNames` | |

### The vocabulary for rules over lists

FXL's [set and glob helpers](./EXPRESSIONS.md#sets--patterns) are what make a
collection rule expressible without a lambda:

```
len(notMatching(outboundHosts, ["*.acme.com"])) == 0     // allow-list
len(intersect(secretsUsed, ["PROD_KEY"])) == 0           // deny-list
matches(workflow.name, "prod-*") ? hasApproval : true    // conditional
```

`matches` is a glob (`*`, `?`), not a regular expression — a caller-supplied
regex is a denial-of-service waiting to happen, and globs are what host
allow-lists are written in anyway.

---

## The starter library

Nine templates ship, offered as one-click adds. They are **templates, not
built-ins**: adding one copies it into the workspace, where it can be edited like
any other rule. Every workspace's allow-list is its own, and a policy nobody can
change is a policy nobody trusts.

| | Severity |
|---|---|
| Outbound calls must use HTTPS | deny |
| Outbound calls must target an approved host | deny |
| Credentials must come from secrets | deny |
| Webhook triggers must be signed | deny |
| Scheduled workflows need a heartbeat | warn |
| AI workflows need a spend budget | warn |
| Deployed workflows need a test scenario | warn |
| Deployed workflows must escalate failures | warn |
| Workflows must stay under 60 nodes | warn |

---

## Design notes

**A policy that cannot be evaluated fails closed.** A broken rule is not a pass.
Because rules are parsed and type-checked when they are saved, a rule throwing
at admission time is an anomaly rather than a typo — and a control that silently
disables itself is worse than no control.

**Violations name their evidence.** Without it, a policy tells you that you are
wrong but not where. `(evil.example.net)` is the difference between a finding
you can act on and one you have to investigate.

**Every change is audited.** `policy.created`, `policy.updated`,
`policy.deleted` go into the [tamper-evident audit
log](./ARCHITECTURE.md#the-tamper-evident-audit-log), and disabling is called
out in the entry's metadata rather than buried in a field diff — a control
quietly switched off the day before a bad deploy is exactly what an incident
review needs to find. A blocked deploy also emits a `workflow.deploy_blocked`
activity event, so the refusal is visible rather than only felt.

---

## The API

Policy management is app-only (owner-scoped, session-authenticated). What the
public API exposes is the **result**:

- `POST /api/v1/workflows/:id/lint` includes `policy-violation` issues, so
  `flowforge lint` gates on "will it run?" and "is it allowed here?" at once.
- `POST /api/v1/workspaces/:id/workflows/import` returns `policyViolations` and
  `policyBlocked`.

Inside the app:

```
GET    /api/workspaces/:wsId/policies
POST   /api/workspaces/:wsId/policies
PUT    /api/workspaces/:wsId/policies/:id
DELETE /api/workspaces/:wsId/policies/:id
POST   /api/workspaces/:wsId/policies/evaluate    { workflowId, rule?, evidence? }
GET    /api/policy-templates
```

`evaluate` with a `rule` dry-runs it against that workflow's real document;
without one it reports how the stored policies judge the workflow. It always
returns the `document`, because a rule is much easier to write when you can see
the fields it may read.
