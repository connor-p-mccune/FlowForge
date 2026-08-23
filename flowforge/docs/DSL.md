# `.flow`: a workflow you can review

FlowForge already has the whole workflows-as-code loop. Export a workflow as a
portable document, put it in git, review it, and CI promotes it to the next
environment. [Drift detection](./API.md#detect-drift-against-an-exported-document)
tells you when git and production have diverged, the [three-way
merge](./MERGE.md) reconciles them, and an [Ed25519
signature](./PROVENANCE.md) proves the graph that arrived is the graph that was
approved.

Every one of those is built around a document a human is supposed to **review**.

And that document is a JSON blob.

```json
{
  "exportVersion": "1.0",
  "name": "Order pipeline",
  "graph_data": {
    "nodes": [
      { "id": "charge", "type": "action-http", "position": { "x": 480, "y": 160 },
        "data": { "label": "Charge card", "config": { "method": "POST", "url": "…" } } }
    ],
    "edges": [
      { "id": "reactflow__edge-approve-charge", "source": "approve",
        "target": "charge", "sourceHandle": "true" }
    ]
  },
  "exportedAt": "2026-03-01T09:14:22.108Z"
}
```

Three things are wrong with that as a review artefact, and they are the reason
this format exists.

1. **Renaming one node is a diff nobody reads.** The change is buried three
   levels into an object whose siblings all look the same.
2. **The connections are somewhere else.** They are a flat array at the bottom
   of the file, hundreds of lines from the nodes they connect, and rewiring a
   branch is four changed lines in a place that gives no clue what they mean.
3. **`git diff` on an unchanged workflow is never empty.** `exportedAt` changes
   on every export. A review artefact that is always dirty is one people stop
   looking at.

---

## The format

```
workflow "Order pipeline"
  description: "Handles incoming orders"

guarantee requires charge approve
  note: "PCI review, 2026-01"

node approve: approval @ 240,160
  label: "Approve refund"
  quorum: 2
  separationOfDuties: true

node charge: action-http @ 480,160
  label: "Charge card"
  method: "POST"
  url: "https://api.acme.com/v1/charges/{{hook.orderId}}"
  headers: {"Content-Type": "application/json"}

node hook: trigger-webhook @ 100,200
  label: "Order webhook"

hook -> approve
approve -true-> charge
```

- `workflow "Name"` — one per file, with an optional `description:`.
- `guarantee <kind> <node> <other>` — a declared [path invariant](./GUARANTEES.md),
  with an optional `note:`.
- `node <id>: <type> @ x,y` — the position is optional and defaults to `0,0`.
- Indented `key: value` lines are the node's properties. `label:` is sugar for
  `data.label`, `data.<k>:` reaches anything else the canvas keeps, and every
  other key is config.
- `a -> b`, or `a -true-> b` for a branch handle.
- `#` starts a comment.

---

## Three decisions

### It is line-oriented because diffs are

FXL — the [expression language](./EXPRESSIONS.md) next door — is a real lexer
feeding a Pratt parser over a token stream, because that is what an expression
grammar needs. This is parsed a **line at a time**, and that is not a shortcut.

A format whose grammar spans lines produces diffs whose hunks span lines. The
entire point of the exercise is that changing one thing changes one line, so the
grammar is built to guarantee it: every construct starts at column zero, every
property is one line, and the only multi-line value is a JSON literal the author
chose to write that way.

### Values are JSON

No bare strings, no custom escaping. `"POST"`, not `POST`.

It is a small ugliness and it buys total fidelity. Workflow config contains
`{{templates}}`, quoted strings, newlines, JSON Schemas, regexes and
occasionally an entire nested object. Inventing a second escaping scheme for
those is exactly how a format starts losing data — and it always loses it on the
day somebody pastes something unusual, in an environment where nobody is looking.

A multi-line JSON value is scanned to its balance point with strings and escapes
honoured, because `{"pattern": "}"}` is a real config and a brace counter that
did not honour them would truncate it.

### The emit order is the signature's canonical order

Nodes sorted by id, edges by `(source, target, handle)`, config keys
alphabetically — **exactly the rules
[`artifactSigning.js`](./PROVENANCE.md) canonicalises with.**

Two things follow:

- **Re-formatting cannot break a signature.** A reviewer can reformat a file
  they were handed and verification still passes. A test signs a JSON export,
  hands over the `.flow`, imports the text, and asserts the signature verifies.
- **Two people who export the same workflow get byte-identical text**, whatever
  order their canvases happened to store things in. So a diff shows what changed
  and nothing else.

`exportedAt` is not rendered at all. It is the field that made an unchanged
export produce a non-empty diff, which is the one thing a review artefact must
never do.

---

## What it refuses to do

**The formatter refuses rather than lies.** A node id containing whitespace, a
colon or an `@` cannot be written in this grammar, so rather than emit something
that would not parse back, `formatWorkflow` throws. A formatter that silently
produced un-round-trippable output would be worse than none, because the damage
would surface at import time in another environment, long after anyone could
connect it to the export that caused it.

**The parser is syntactic only.** An edge naming a node that does not exist
parses fine. That is not an oversight: the [linter](./ARCHITECTURE.md#static-analysis-the-linter)
already reports a dangling edge with the node named, and a text format that grew
its own second opinion about what a valid graph is would be a second thing to
keep in agreement with the engine. `flowforge lint <id> file.json` is the gate;
this is the notation.

**Unknown properties are an error, not a shrug.** `descriptoin:` is refused with
a line number rather than dropped. A declaration that silently stops applying is
the failure mode every governance feature in this codebase is built to avoid.

---

## The round trip, as a property

`parse ∘ format` is the identity on a workflow's **semantics** — asserted over
300 generated documents whose config values are deliberately the ones a naive
format loses: quotes, backslashes, tabs, newlines, `{{templates}}`, unicode,
strings that look like JSON, and nested objects.

Two claims, both tested:

```
semantics(parse(format(doc))) ≡ semantics(doc)     # nothing is lost
format(parse(format(doc)))    ≡ format(doc)        # formatting is a fixed point
```

The second matters as much as the first: without it a file could churn on every
round trip, and a format that rewrites itself is a format that fills a pull
request with noise.

Edge **ids** are outside the promise, for the same reason the signature excludes
them: React Flow mints a new id for a redrawn connection, so an edge id is a
canvas artefact rather than part of what the workflow means. The parser
synthesises `source-target[-handle]`, which is what the canvas produces anyway.
The same goes for a node's transient view state — `selected`, `dragging`, a
measured width. Those are not part of what a workflow *is*, which is precisely
why the signature and the merge already exclude them.

---

## Surfaces

| Where | What |
|---|---|
| `flowforge export <id> --flow` | Writes the text form to stdout. `> workflows/sync.flow` puts it in git. |
| `flowforge import <ws> sync.flow` | Sends the text; the server parses it. A syntax error comes back as `Line 12: …`, the position the parser found. |
| `GET /api/v1/workflows/:id/export?format=flow` | `text/plain`, not JSON-wrapped — the point of the format is being a file in a repository. |
| `POST /api/v1/workspaces/:id/workflows/import` | Accepts `{ flow: "…" }`, parsed into the same shape the JSON path produces so the size cap, the signature check and the guarantees stay one code path. |
| `diff`, `lint`, `merge`, `preview` | Every endpoint and command that takes a **document** accepts either form. A `.flow` file that could be imported but not diffed, linted, merged or previewed would be a format nobody could adopt, so the resolution happens once, in front of all of them. |
| **`</> Text` on the canvas** | The workflow as text, editable. See below. |
| `PUT /api/workflows/:id/flow` | Replaces the workflow from its text form. Writes the *whole* document — name, description, guarantees, graph. |

### Editing as text

The canvas is for drawing; text is for surgery.

Renaming twelve nodes, repointing five HTTP nodes at a new host, or reordering
a switch's cases are each **one find-and-replace** in a text editor and twelve
dialogs on a canvas. The second is why people give up and edit the database.

Applying goes to the server, which parses and writes, and the canvas then
reloads the result — the same shape as a merge or a version restore, and for
the same reason: the collaboration layer sees one external change rather than a
storm of synthetic edits, and there stays exactly one parser.

A syntax error comes back with a line, a column and the offending source, and
the panel **uses** all three: the frame is rendered under the box and the caret
moves to the position. A position that is reported and not used is a position
the reader has to count to.

The Export menu in the app offers both, because they answer different
questions: the JSON is what a machine consumes on the way back in, and the
`.flow` is what a human reads in a pull request.

The CLI deliberately carries **no copy of the grammar**. Unlike the signing
canonicalisation — which is duplicated there because signing has to work
offline, with no server to trust — a formatter has no such requirement, so the
text goes over the wire and the server is the only thing that knows what the
format is.
