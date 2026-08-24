# Contracts: what a workflow promises the workflows that call it

FlowForge already types a caller against its callee. `typeInference`'s
sub-workflow rule walks into the target workflow, computes what it actually
returns, and checks `{{sub.orderId}}` against that shape. If the field is not
there, the caller gets a lint error.

That is the right direction for one half of the problem, and the wrong direction
for the other half — which is the half that hurts.

> **The author who breaks the contract is not the author who finds out.**

Rename a field inside a sub-workflow's return node, and:

- the callee **still lints** — nothing about its own graph is wrong;
- every existing caller keeps referencing the old name, which now resolves to
  nothing;
- the callee's author sees **no error at all**, because the broken reference is
  in somebody else's workflow — possibly one they cannot see;
- the caller's author finds out at run time, when a field arrives `undefined`
  and an HTTP body goes out with a hole in it.

The [dependency graph](./ARCHITECTURE.md) does not catch it either.
`workflowDependencies` asks whether the reference to the *workflow* still
resolves — whether the target still exists. It does. What changed is the shape
of what it returns, and a reference check cannot see a shape.

The surfaces are `flowforge contract <id> [file] [--strict]`,
`POST /api/v1/workflows/:id/contract`, the session route for the canvas, and
`GET /api/v1/workflows/:id/contract` for reading the current promise.

---

## The rule is variance, and it runs the other way

A workflow's return type is a promise to its callers. A change keeps the promise
when the new type is **substitutable** for the old one — when every value the
callee can now return is one the caller was already prepared to handle:

```
T_after  <:  T_before
```

That is covariance of return types, and `types.js` already had the subtyping
test for it (`T.accepts(want, got)` asks whether `got <: want`). So the whole
check is one call in the right direction.

| | Safe | Breaking |
|---|---|---|
| **Fields** | adding one | removing one |
| **Types** | **narrowing** | **widening** |
| **Optionality** | optional → required | required → optional |

**Both of the last two rows are the opposite of the intuition people carry over
from function arguments**, and for the same reason. A return value is something
the caller *consumes* rather than supplies, so the permissive direction flips.

- Narrowing `"ok" | "failed"` to `"ok"` leaves a caller's `else` branch dead.
  Dead, not broken.
- Widening `number` to `number | string` hands a caller doing arithmetic a
  string.
- A required field going optional means a caller that read it unconditionally
  may now get nothing.
- An optional field becoming required can only ever give a caller *more*.

Which makes this semantic versioning for workflows: `additive` is a minor
change, `breaking` is a major one, `compatible` is a patch.

### Compared against the saved graph, not a declared interface

Nobody writes a workflow's return shape down. They build a graph and the shape
falls out of it. So the contract is **whatever the deployed version returns
today**, and the question is whether the candidate still honours it.

That makes this a check on a *diff* rather than on a document — which is also
what lets a finding name the exact reference that stops resolving, instead of a
schema mismatch nobody can locate.

---

## Two levels, and only one is a gate

```console
$ flowforge contract 6f0c… fulfilment.flow --strict
Contract for Fulfilment
  returns { total: number }
  change  breaking

What changed
  − orderId (was string)
  + trackingId (string)

1 reference(s) would stop resolving
  Orders
    {{call.orderId}} in Fulfil order — no "orderId"; did you mean "order_id"?

  2 other caller(s) unaffected.

  3 caller(s) · 1 broken · contract is breaking
```

| | Means | Fails a build? |
|---|---|---|
| `change.verdict: breaking` | The shape lost something. | Only with `--strict`. |
| `summary.broken > 0` | A caller has a reference that **stops resolving**. | Always. |

A contract can narrow with nobody currently relying on the part that went. That
is worth knowing and is not a deployment to stop, and a pipeline that failed on
it would be failing on changes nobody is affected by — which is how a check
earns its way out of a pipeline. `--strict` opts into the stricter reading, for
a team that treats the contract itself as the artefact.

---

## Precision

Every ambiguity resolves toward **fewer** findings, because a break claimed and
not real sends somebody to fix a workflow that was fine.

- **An open return type breaks nobody.** A workflow returning an untyped webhook
  payload promises the fields it names and nothing about the rest, so a
  reference into it is never reported as broken — the field may well be there.
- **A `for-each` caller is listed as affected with no break named.** Its output
  wraps the contract in `{ count, succeeded, results: [T] }`, and a template
  path cannot index an array, so there is no resolvable reference into the
  contract to break. Naming one would be fiction; omitting the caller entirely
  would hide a real dependency.
- **Error-handler edges are excluded.** An error handler receives the *failure*,
  not the failed workflow's return value, so nothing about that shape was ever a
  promise to it.
- **The flatten is full-depth**, not the field picker's two levels. A caller can
  reference `{{sub.customer.address.city}}`, and a comparison that stopped
  looking at depth 2 would call removing it compatible. (Capped at 8, because a
  self-referential shape would otherwise walk forever and nothing that deep is a
  contract anybody is reasoning about.)
- **References are collected from the whole config tree**, not just top-level
  strings — `headers: { "X-Order": "{{call.orderId}}" }` counts.

---

## What it does not do

- **It does not check inputs.** A sub-workflow's *input* is whatever the caller
  passes, and the callee has no declared parameter list to violate. That is a
  real gap and a different feature; this one is about the return.
- **It does not cross workspaces.** Neither does the sub-workflow runner, so a
  caller in another workspace is not a caller.
- **It cannot see a dynamic reference.** `{{sub[field]}}` is not a syntax the
  template engine has, but a config value assembled at run time from a variable
  is beyond any static reference check.
- **It does not version anything.** It reports that a change is breaking; it has
  no opinion about whether you should make it. Sometimes the answer is to fix
  the callers, which is why they are named.
