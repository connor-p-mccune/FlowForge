# Static types

FlowForge knows the shape of the data moving through your workflow, and checks
your references and expressions against it — before you run anything.

A canvas is a dataflow graph. Every node's runner returns a shape it guarantees
(an HTTP node yields `{ status, body }`; a Filter yields `{ items, count,
total }`), and the engine merges those shapes into each downstream node's input.
That is a type, and writing it down turns two whole classes of 3am bug into a
lint finding:

```
{{http-1.bdy}}          →  error: h1 is { status: number, body: any } and has no "bdy";
                                  did you mean "body"?
tags.length > 0         →  error: string[] has no field "length" — expressions have no
                                  ".length"; use len(…)
amount * customer       →  error: "*" needs numbers, but the right side is { id: string, … }
dateAdd(now(), 1, "weeks") → error: dateAdd() unit must be one of seconds, minutes, hours, days
```

- [Where you see it](#where-you-see-it)
- [The type language](#the-type-language)
- [What each node produces](#what-each-node-produces)
- [How types travel the graph](#how-types-travel-the-graph)
- [Expressions](#expressions)
- [When FlowForge says nothing](#when-flowforge-says-nothing)
- [The API](#the-api)

---

## Where you see it

**The config panel.** "⚡ Insert data from upstream" lists every upstream node
with the fields it actually produces and the type of each one. Click a chip to
copy its `{{node.path}}` reference.

**The 🔎 Issues panel.** Type findings ride alongside every other lint result,
with the same severity contract: **error** means the run will misfire, **warning**
means it's legal but computes something nobody wants.

**CI.** `flowforge lint <id>` fails on a type error like any other. If you want a
narrower gate, `flowforge types <id>` fails on type problems *only*.

**The terminal.** `flowforge types <id> --node http-1` prints one node's shape and
its paste-ready references.

---

## The type language

| Type | Means |
|---|---|
| `number`, `string`, `boolean`, `null` | exactly that |
| `T[]` | a list of `T` — `string[]`, `{ sku: string }[]` |
| `{ a: number, b?: string }` | an object; `?` marks a field that may be absent |
| `{ a: number, … }` | an **open** object — it has at least `a`, and may carry more |
| `A \| B` | either |
| `any` | dynamic **by contract** — a parsed HTTP body, extracted AI data |
| `unknown` | FlowForge has nothing to say — a node type with no contract, a sub-workflow whose target can't be resolved |

`any` and `unknown` are different facts, and the distinction is worth keeping:
one says "this is whatever the API sent", the other says "we couldn't work it
out". **Neither can ever produce an error.** Every check in the type system
stands down the moment it meets one, because an analysis that guesses is worse
than one that abstains.

---

## What each node produces

Transcribed from the runners, not invented — if a node's output grows a field,
this table is what has to grow with it.

| Node | Output |
|---|---|
| any `trigger-*` | `{ triggered: boolean, … }` — open, because the payload is yours |
| HTTP request | `{ status: number, body: any, dryRun?: boolean, wouldHaveSent?: object }` |
| Delay | its input, plus `delayedMs: number` |
| Send email | `{ sent?, simulated?, messageId?, to?, subject?, … }` |
| Slack | `{ ok?: boolean, text?: string, … }` |
| Transform | **the shape of its template** — see below |
| Filter | `{ items: T[], count: number, total: number }` |
| Map | `{ items: M[], count: number }` where `M` is what the mapping expression computes |
| Aggregate | `{ count: number }`, plus `sum/avg/min/max` with a value expression, or `groups` when grouped |
| Condition | `{ result: boolean }` |
| Switch | `{ result: string, matched: boolean, matchedLabel: string, matchedIndex: number }` |
| Validate | `{ result: string, valid: boolean, errors: { path, message }[], data: any }` |
| AI prompt / classify / extract | `{ text: string }` / `{ label: string }` / `{ data: any }` |
| Log output | `{ message: string }` |
| Return output | its input |
| Approval | `{ result: boolean, outcome: string, respondedBy?, note? }` |
| Wait for callback | `{ result: string, payload: any, receivedAt? }` |
| For each | `{ count, succeeded, failed, results: T[], errors? }` — `T` from the target workflow |
| Sub-workflow | **the target workflow's own return type** — see below |

### Sub-workflows are resolved across graphs

A sub-workflow node's output is whatever the target workflow returns, so the
analysis recurses into that workflow's graph and applies the engine's own return
rule: the `output-return` node's output if the graph has one, otherwise the last
node in execution order that produced anything.

It resolves the same targets the runner would accept — **same workspace,
deployed** — because typing a node from a target the runner would refuse would
report a shape the run can never produce. Three cases give up and report
`unknown` instead, each because that is the honest answer:

- a **cycle** (a workflow that calls itself, or A → B → A). The engine rejects
  that at run time and `flowforge deps` reports it statically; inventing a type
  for it would be fiction.
- a call chain deeper than **three levels** — past that the work is not worth
  doing on every keystroke.
- a target that can't be resolved (deleted, undeployed, another workspace). The
  linter reports the real problem in its own words.

### The Transform node is special

A Transform node returns its template verbatim, which makes the template the one
place in the product where **you** write an output shape down. So it's read as
one:

```json
{ "orderId": "{{trigger-1.id}}", "code": "{{http-1.status}}", "label": "HTTP {{http-1.status}}" }
```

- `"{{http-1.status}}"` is *exactly* one placeholder, so it keeps the referenced
  value's type — `code` is a `number`.
- `"HTTP {{http-1.status}}"` interpolates, so `label` is a `string`.

Which is exactly what the engine does at run time.

---

## How types travel the graph

A node's input is the merge of its active upstream outputs — `Object.assign`, in
the engine's own terms — and the analysis models that rather than approximating
it.

**A branch may not fire.** If a node is fed by two branches of a condition, each
branch's fields are marked optional (`{ text?: string, label?: string }`),
because only one of them ran. But a node with a *single* incoming edge always
got that edge — if it's executing, that's how it got there — so its fields stay
required even off a branch.

**A caught failure is data.** A node whose on-error policy is `continue` settles
`{ failed, error }` instead of its own output and carries on down the same
edges, so downstream sees the union of both. Under `branch`, that error object
travels only the error handle, and the normal handles keep the normal shape.

**An untyped upstream opens the merge.** Merge an `unknown` into an input and the
result is open: the fields we do know are still listed, and nothing else is
claimed.

---

## Expressions

FXL expressions are checked against what the graph proves is in scope, which
differs per node:

| Node | Scope |
|---|---|
| Condition, Switch | the merged input's fields directly, plus `input` for the whole bag |
| Filter, Map, Aggregate | each item's fields directly, plus `item`, `index`, `items` |

So a Filter over `{{orders.rows}}` where `rows` is `{ sku: string, qty: number }[]`
knows that `qty > 1` is fine and `quantity > 1` is not.

Beyond scope, the checker knows the whole standard library's signatures and
catches:

- **arithmetic on something that can never be a number** — `amount * customer`.
  (Numeric *strings* are fine: FXL coerces them, so `"10" * 2` is legal.)
- **a bad argument or the wrong number of them** — `sum(status)`, `round(x, 2, 3)`.
- **a field that cannot exist**, with a suggestion.
- **`.length`**, which deserves its own line: it is a number in a `{{…}}`
  template and silently `undefined` in an expression, because the two read
  paths have genuinely different member semantics. Use `len(items)`.
- **a bad date unit** — `dateAdd(t, 1, "weeks")`.

and warns about expressions that are legal but useless:

- ordering two objects (`a > b` stringifies both to `[object Object]`, so every
  comparison reports equal),
- comparing an object with a primitive (always false),
- `in` against a number (nothing to search).

---

## When FlowForge says nothing

Deliberately, and often. There is **no** finding when:

- the value is `any` or `unknown` — an HTTP body, extracted AI data, a
  sub-workflow whose target can't be resolved;
- the object is open — a webhook trigger's payload, or any merge that included
  something untyped;
- the type is a union with a viable option — `number | object` might be a
  number, so multiplying it is not provably wrong;
- the node isn't wired up yet — a node with no upstream has no established
  input, so a half-built canvas doesn't fill with findings about data you
  haven't connected;
- the graph has a cycle — the linter already reports that, and inference over a
  cycle would be fiction.

This is the property that makes the checker usable. A finding here is a bug you
have; if it were a bug you *might* have, you'd stop reading them.

---

## The API

```console
$ curl -H "Authorization: Bearer $FLOWFORGE_TOKEN" \
    "$FLOWFORGE_URL/api/v1/workflows/$WORKFLOW_ID/types"
```

```json
{
  "workflowId": "6f0c…",
  "order": ["trigger-1", "http-1", "log-1"],
  "nodes": {
    "http-1": {
      "input":  { "described": "{ triggered: boolean, … }", "type": { "kind": "object", … } },
      "output": {
        "described": "{ status: number, body: any }",
        "type": { "kind": "object", … },
        "fields": [
          { "path": "status", "type": "number", "optional": false },
          { "path": "body",   "type": "any",    "optional": false }
        ]
      }
    }
  },
  "diagnostics": []
}
```

`described` is the human rendering, `type` is the machine-readable lattice value
(stable, JSON, diffable), and `fields` flattens the pickable `{{node.path}}`
references one level past each object.

No run history is consulted, so a workflow that has never executed still reports
a full schema.

Inside the app, `POST /api/workflows/:id/types` takes the same body contract as
the lint endpoint — post `{ nodes, edges }` to analyse an unsaved canvas, or an
empty body for the stored graph.

---

**See also:** [EXPRESSIONS.md](./EXPRESSIONS.md) for the expression language
itself, and [ARCHITECTURE.md](./ARCHITECTURE.md#the-type-system) for why it is
built this way.
