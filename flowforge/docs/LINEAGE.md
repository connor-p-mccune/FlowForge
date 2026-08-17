# Data lineage

Where a value came from, where it ends up, and who controls it.

```
Charge card — what feeds it

  untrusted  the webhook payload
             written by whoever holds the trigger URL

  Order webhook → Normalise   {{hook.host}}    in template
  Normalise     → Charge card {{shape.target}} in url

  (its own output is an HTTP response — data flowing out of this
   node was written there, not here)

⚠ Charge card: the address this request is sent to is built from the
  webhook payload — via {{shape.target}}
```

---

## The gap this closes

[TYPES.md](./TYPES.md) recovers the **shape** of what flows between nodes.
Nothing recovered the **path**.

`{{http-1.body.email}}` in a Send Email node tells you a field's name and
nothing about its provenance — which trigger field it started as, which nodes
reshaped it, whose API supplied it. Six nodes later nobody can reconstruct that,
and two questions become unanswerable:

- **If I change this, what breaks?** `flowforge deps` answers it between
  workflows. Inside one, there was nothing.
- **Is anything reaching that URL controlled by whoever sends the webhook?**
  Server-side request forgery with a drag-and-drop interface, and completely
  invisible on a canvas.

One pass over the DAG recovers the dataflow the same way the type checker
recovers the shapes — reading exactly what the engine reads.

---

## Origins: where data comes from

Every node gets a set of **origins** describing where its *output* data can have
come from, each carrying a trust level.

| Origin | Trust | Meaning |
|---|---|---|
| `webhook` | **untrusted** | the trigger payload — written by whoever holds the URL |
| `callback` | **untrusted** | a Wait-for-Callback payload — whoever was handed the token |
| `response` | **external** | an HTTP response — written by the service that answered |
| `model` | **external** | generated text, not a value the workflow chose |
| `manual` | internal | a member's or a scoped token's input |
| `schedule` | internal | a cron tick; no payload |
| `secret` / `variable` | internal | workspace configuration |
| `config` | internal | what the author typed |
| `unknown` | unknown | a sub-workflow's return — not guessed at |

Three levels rather than a boolean, because collapsing them either cries wolf or
misses the case that matters. A third-party API is not an attacker, but it is
not the workflow's author either.

### Taint stops at an external boundary

An HTTP node's `body` is **the far side's answer**, not a function of the URL it
was asked for. So a request built from a webhook produces a response that
carries `response`, not `webhook`:

```
{{trigger.id}} → [HTTP node] → body        // origins: response, NOT webhook
```

This is the single most important decision in the module. Propagating the
request's taint into its response would mark most of a typical graph, and a
finding that fires everywhere trains people to ignore it. The same applies to AI
nodes: the model wrote the text.

A **Transform** node is the mirror case — it never merges its input, building
its output entirely from its template's `{{…}}` references. So a Transform over
literals launders nothing and stays silent, while one that copies a webhook
field carries the taint forward exactly as it should.

---

## Sinks: where data leaves

A **sink** is a config field whose value leaves FlowForge. `sensitivity` is about
what an attacker gains by controlling it, not how secret the data is.

| Sink | Sensitivity | Field |
|---|---|---|
| `http-url` | high\* | where the request goes |
| `http-headers` | high | including credentials |
| `email-recipient` | high | who receives it |
| `slack-webhook` | high | which workspace and channel |
| `workflow-target` | high | which workflow runs |
| `http-body`, `email-body` | medium | what is sent |
| `email-subject`, `slack-message`, `log` | low | text |

\* **A pinned host is not SSRF.** `https://api.acme.com/orders/{{trigger.id}}`
is how requests are supposed to be built — the author fixed the destination and
only a path segment varies. Only a dynamic **authority** (everything before the
first `/`, `?` or `#` after the scheme) lets a caller choose what the server
connects to:

| URL | Reported? |
|---|---|
| `https://api.acme.com/orders/{{hook.id}}` | no — host pinned |
| `{{hook.url}}` | **yes** |
| `https://{{hook.host}}/v1` | **yes** |
| `{{hook.scheme}}://api.acme.com/x` | **yes** |
| `{{hook.base}}/orders` | **yes** — no scheme, could resolve anywhere |

Slack's webhook URL is deliberately *not* softened the same way: for Slack the
path **is** the credential.

---

## The findings

All three are warnings, never errors, and all appear in the Issues panel,
`flowforge lint`, and `flowforge lineage`.

### `tainted-sink`

Something outside the workspace controls a value that decides where data goes.
The message names the specific source and the specific reference, so an author
can recognise their own design in one read:

> **Charge card**: the address this request is sent to is built from the webhook
> payload (written by whoever holds the trigger URL) — via `{{shape.target}}`

A warning because it is frequently deliberate — a webhook that carries its own
reply-to URL is a real and correct pattern.

### `prompt-injection`

The same shape as `tainted-sink` with a model in the middle. An AI node
classifies a webhook body — text written by whoever holds the trigger URL — and
text can read as instructions, so that party can steer the model. If the model's
answer then decides where a request goes or which branch runs, they have steered
the workflow.

> **Fraud check**: this node's text is built from the webhook payload (written by
> whoever holds the trigger URL), and it chooses which of this node's labels is
> returned — and that decides which branch **Low risk?** takes. Via
> `{{hook.body}}`.

**The finding is a composition, and that is the whole point.** Untrusted data
reaching a prompt is what an AI node *is for*; reporting that would fire on every
one of them. So it is reported only when the answer *also* influences a
high-sensitivity sink or a routing node. An answer that lands in a log line is a
smaller problem and stays silent.

Three narrowings keep it precise:

- **Only `untrusted` counts, not `external`.** An HTTP response feeding a prompt
  is a third party's text, not an adversary's *choice* of text. Counting it would
  mark most graphs that use AI at all.
- **The message names what an injection can reach**, because the three cases are
  different exposures: free text from an `ai-prompt`, one of the **declared
  labels** from `ai-classify` (the AI service refuses anything else), the
  extracted values from `ai-extract`.
- **A routing node counts through graph successors as well as reads.** A
  condition in expression mode reads `label` off its merged input and names no
  `{{…}}` reference, so the read graph is blind to that edge. Bounded to
  *immediate* successors, because the engine merges only immediate predecessors —
  anything further away had to reference the value, which the read closure
  already covers.

The corresponding containments live at the boundary rather than here — a per-call
random fence around untrusted text, and a classification confined to the declared
labels — so every AI node gets them without its author opting in. See
[SECURITY.md](../SECURITY.md) (T19).

### `unread-output`

A node that exists to produce a value, whose value nobody reads. The bar is
deliberately high: a node **mid-chain** still has its output merged into every
downstream node's input by the engine, so "nothing references it by name" is not
"nothing uses it". Only a **leaf** — no outgoing edge and no `{{…}}` reference
anywhere — provably computed something for nobody.

On an AI node this is not a curiosity, it is a bill, and the message says so.

---

## The two questions

```bash
flowforge lineage <workflow-id>                  # the map
flowforge lineage <workflow-id> --node charge    # one node, both directions
flowforge lineage <workflow-id> --strict         # gate CI on the findings
```

On the canvas, **🔗 Lineage** shows the map; selecting a node switches to that
node's trace, and every name in it is clickable, so tracing a value backwards is
a sequence of clicks.

### Provenance — what feeds this?

Walks the read edges back to their sources and reports the origins they
terminate in, plus the chain of references that carried the value.

Note it reports **two** origin sets, and the difference is the point: `origins`
is where the data this node *reads* came from, `outputOrigins` is where its own
output was written. They differ exactly at an external boundary.

### Impact — what breaks if this changes?

The transitive closure of "references this", plus the sinks downstream — because
a change here changes what leaves the system.

**Impact deliberately crosses the boundaries taint stops at**, and the asymmetry
is correct rather than an oversight:

> Taint asks *who controls this value's content*. Impact asks *what does this
> value participate in deciding*.

Changing a webhook field does not make an HTTP response untrusted in any new way
— the far side always wrote it — but it does change **which URL is called**, so
everything downstream of that response really is affected.

---

## Secret reach

The lineage also reports, per secret, which nodes can read it. Not a finding —
a fact. "Who can read `STRIPE_KEY`?" is a question every workspace eventually
asks, and the answer was otherwise a manual grep of every node's config.

It pairs with [policies](./POLICIES.md), which is where a rule about it belongs:
lineage reports what is true, a policy decides what is allowed.

---

## Limits, stated plainly

**Attribution is per-node, not per-field, except where a runner's contract makes
it per-field.** A `{{…}}` reference is a field reference and is tracked as one;
the origins it carries are the source node's, which is node-granular. A Transform
mapping one field to another does not currently narrow that.

**FXL expressions read the merged input**, not a named node, so an expression's
reads are attributed to every active upstream node rather than to one. That is
over-inclusive in the safe direction for impact and is why expressions do not
themselves produce taint findings — the sinks that matter all take `{{…}}`
templates.

**A sub-workflow's return is `unknown` and stays that way.** Following it would
mean analysing another graph with another workspace's secrets in scope; the
honest answer is that this analysis does not know, and `unknown` silences every
check downstream of it — the same rule the type system uses.

**Nothing here is enforced.** Lineage reports; the [policy engine](./POLICIES.md)
is what refuses a deploy, and `flowforge lineage --strict` is what fails a build.
