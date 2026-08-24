# Convergence: where parallel branches collide

The engine runs independent branches in parallel. When several of them arrive at
the same node, that node's input is built by assigning their outputs over each
other:

```js
Object.assign(base, ...activeIncomingFor(nodeId).map((e) => context[e.source]))
```

`Object.assign` is last-writer-wins. So if two branches both produce a `status`,
exactly one of them survives — and the question this document is about is which,
and what decides it.

The surfaces are `flowforge converge <id>`,
`GET /api/v1/workflows/:id/convergence`, a linter warning, and the canvas.

---

## The bug this started as

Until recently, the winner was decided by **the order the edges happened to sit
in the array**.

Three facts, each unremarkable on its own:

1. **The merge is positional.** Later contributor wins.
2. **"Later" meant later in `graph.edges`** — the order the author drew the
   connections. Nothing on the canvas shows it. React Flow appends; deleting and
   redrawing a connection moves it to the end.
3. **Three parts of the product rewrite that order, and they disagree.**

| Path | Edge order it produces |
|---|---|
| A plain `PUT /api/workflows/:id` | the array, as drawn |
| A collaborative session | sorted by **edge id** — `graphCrdt.materialize()` |
| `.flow` export, and the artifact signature | sorted by **(source, target, handle)** |

Put together: the same graph, saved through the collaborative editor rather than
a plain save, or round-tripped through its own signed export, could compute a
**different value** — with the linter, the type checker, the guarantees, the
policies and the signature all still green.

The last one is the sharpest. `export → review → import` is the promotion path
[provenance](./PROVENANCE.md) exists to protect, and the signature is
deliberately over the graph's *canonical* form so that dragging a node doesn't
break it. That canonicalisation sorts the edges. The signature verifying was
never a claim that behaviour was preserved, and here it wasn't.

### Why no existing check caught it

The type checker gets closest and cannot possibly see it. `T.mergeAssign` takes
the colliding field types and **joins** them:

```js
fields[name] = { type: join(existing.type, spec.type), optional: … }
```

That is the correct, sound answer. The value really could be either, so the type
is the union of both. And it is *precisely by being sound* that it discards the
only thing that makes this a bug: which one you actually get. A widening
abstraction is supposed to forget the difference between two values it has
merged. There was no gap in the type system to fill — the question is simply not
a typing question.

---

## The fix: order the merge by the graph, not by the storage

Contributors are now ranked by **longest-path depth**, computed over the graph
itself:

```
depth(n) = 0 if n has no predecessors, else max(depth(p)) + 1 over p ∈ pred(n)
```

Deeper wins. Two properties make this the right key rather than merely a stable
one:

- **It is structural.** Depth is a fact about the shape of the graph. No storage
  layer, canonicalisation, CRDT materialisation or import can change it, so all
  three paths above now run identically.
- **It matches what the canvas looks like it means.** In `A → B → N` and
  `A → N`, B ran *after* A and had A's value in its own input. B's `status` is
  the later fact, so B's supersedes A's. And because any path of length L from A
  to B forces `depth(B) ≥ depth(A) + L`, sorting by depth **always** puts an
  ancestor before its descendant — the property is guaranteed, not hoped for.

Where the graph is genuinely silent — two contributors at the same depth,
neither reachable from the other — something arbitrary has to break the tie. That
something is the **canonical edge sort**, the same `(source, target, handle)` key
the `.flow` format and the signature use. So the order a reviewer reads the
document in is the order the engine applies.

The test that pins it is a permutation test, in the style the
[CRDT](./ARCHITECTURE.md#real-time-collaboration) uses: all 24 orderings of a
diamond's four edges, one merged input. Before the change, the same 24 orderings
produced two.

---

## What no order can fix

A deterministic tie-break is not a *correct* tie-break. When two concurrent
branches both supply `status`, the engine now reliably picks the same one — and
it picks it alphabetically, which is not an opinion about the workflow.

So the analysis reports exactly that case, and separates it from the one that
needs nobody's attention:

| `resolution` | What it means | Worth reporting? |
|---|---|---|
| `dataflow` | The contributors sit at different depths. The deeper one ran later and wins predictably. | No — a reader can work it out from the canvas. |
| `tie-break` | Same depth. Genuinely concurrent. The canonical sort decides. | **Yes.** Only a human can say which branch should win. |

```console
$ flowforge converge 6f0c…
Where parallel branches collide
AT        FIELD   SUPPLIED BY                    WINS                     DECIDED BY
Combine   status  Billing lookup + CRM lookup    CRM lookup (alphabetical) tie-break
Finalise  total   Subtotal + With tax            With tax (ran later)      graph

  2 collision(s) at 2 join(s) · 1 settled by the graph · 1 decided by a tie-break
```

`--strict` exits non-zero on `summary.tieBroken` alone. A pipeline that failed on
settled collisions too would be failing on graphs that are fine, and a check that
fires on correct input is a check somebody deletes.

---

## The precision work is in what it stays quiet about

**Branches that can never both run are not a collision.** A condition with its
`true` and `false` handles wired into one join node is on every canvas anybody
has ever drawn. Exactly one handle activates, so nothing is ever assigned over
anything. Reporting it would bury every real finding under the pattern people are
taught to draw.

Establishing that needs the **outcome partition** from
[`guarantees.executionGraph`](./GUARANTEES.md) rather than a reachability test,
and the reason is a nice one: a decision is not in its own reach set, so an edge
leaving the decision *itself* belongs to no group under a reach-only rule and
would look co-active with its own sibling. Two edges are exclusive when some
decision `D` assigns them to different outcome groups — reading the handle
directly when the edge leaves `D`, and requiring `D` to **dominate** the source
otherwise, since a source reachable by a path that never touches `D` can run
whatever `D` chose. That is the same two-part rule
[effect reachability](./EFFECTS.md) uses, applied to a pair instead of a node.

**Two edges out of one node are not a collision.** They carry the same object;
assigning it twice writes the same value.

**A field two catching nodes merely *could* both produce is not a collision.**
`{{node.failed}}` is a legitimate reference on any node whose failure is caught,
so `outputs` includes the engine's error object — but a *normal* edge carries
only the node's own shape. Asking `outputs` rather than `normalOutputs` would
report `failed` and `error` colliding at every join between two catching nodes,
which is a fiction. (An edge leaving a real `error` handle does carry it, and
that collision is reported.)

**A shape it cannot see into produces nothing.** A node whose output the
inference cannot name contributes no field names and therefore no findings.
Fewer findings, never invented ones — the same one-sided honesty every analysis
here is built on.

---

## What it does not do

- **It does not know which branch *should* win.** That is a fact about the
  business, not about the graph. The report says the graph does not record it.
- **It does not see a field nobody declared.** Collisions are found between
  *inferred* field names, so two nodes returning open objects full of dynamic
  webhook data collide invisibly. This is the recall cost of never inventing a
  finding, and it is the trade every static pass here makes.
- **It does not rank by damage.** A colliding `status` and a colliding
  `customerId` read identically. Only `sameType` is annotated, because a
  differently-shaped winner changes what a downstream expression is *allowed* to
  do, which is checkable; "this field matters more" is not.
- **It is not a race detector.** Nothing in FlowForge lets two nodes write shared
  state — the collision here is over the merged input of one node, which is a
  question about the graph rather than about timing. The answer does not depend
  on which branch finished first, and never did; it depended on how the graph was
  stored, which is worse and is what got fixed. Two *runs* touching the same
  external resource is a different subject, and
  [idempotency keys](./DURABILITY.md#the-escape-hatch-a-key-the-far-side-recognises)
  are where it lives.
