# Mutation testing: are these checks any good?

FlowForge has a lot of ways to check a workflow.

| | Answers |
|---|---|
| [The linter and type checker](./TYPES.md) | Is this graph well formed? |
| [Test scenarios](./ARCHITECTURE.md) | Does it produce the right answer for these payloads? |
| [Guarantees](./GUARANTEES.md) | Does this invariant hold over every execution? |
| [Path feasibility](./PATHS.md) | Can an input reach this branch? |

Every one of them answers **"does this workflow pass?"** None answers the
question underneath:

> **If this workflow were subtly wrong, would any of them notice?**

That question has an uncomfortable answer more often than anybody expects. A
suite of three scenarios that all assert `status == "completed"` passes on a
workflow with its approval gate deleted. A guarantee nobody declared cannot
break. **Green is not the same as covered**, and until this existed nothing in
the product could tell the two apart.

The surfaces are `flowforge mutants <id>`,
`POST /api/v1/workflows/:id/mutations`, and the session route for the canvas.

---

## The method

Introduce a plausible bug. Re-run every check. See whether anything goes red.

A mutant nothing catches is a gap in the checks, named precisely — not
*"coverage is 61%"* but:

> *"the approval gate can be deleted and every one of your tests still passes."*

That is the whole difference. A percentage tells you a fifth got through; it
tells you nothing about **which** fifth, and the fifth is the part that matters.

---

## The operators are bugs, not noise

Random perturbation produces mutants nobody would ever write, and a report full
of those is one people stop reading. Each operator is a mistake somebody has
actually made:

| | The bug |
|---|---|
| `swap-branches` | A condition wired backwards. The commonest copy-paste error on a canvas, and invisible: both edges exist, both lint, the graph looks right. |
| `off-by-one` | `> 100` becomes `> 101`. The threshold bug that survives every test whose payloads are nowhere near the boundary. |
| `remove-gate` | An approval or a validate deleted and the graph rewired past it. |
| `skip-node` | A step removed. Tests whether anything asserts on what it produced, or whether it is decoration. |

Most of the care is in what is deliberately **not** generated:

- **A condition with only one side wired is not swapped.** The result is a
  branch leading nowhere, which the linter refuses — so the mutant would be
  killed by a check that noticed the *mutation* rather than the bug.
- **`off-by-one` splices at the lexer's token position**, not by regex, so the
  `100` in `total > 100` moves and the `100` inside `"order-100"` does not.
  An expression with two numbers is declined entirely: which one somebody meant
  is a guess, and a mutant nobody recognises is noise.
- **Removing a gate rewires only its pass branch.** A rejection leads somewhere
  by design, and reconnecting it to the happy path would model a different bug.
- **Removing a step is limited to one edge in and one out.** Rewiring a join
  models a structural change rather than a missing step.
- **Operators are interleaved, not grouped**, so a cap that truncates the list
  still leaves a spread. Twelve off-by-ones and no removed gate would be a worse
  report than three of each.

---

## Three ways to die, cheapest first

A mutant is killed by whichever check notices first, and the order is both
cheapest-first and best-first:

1. **The linter or type checker** refuses it — caught before a run, for free,
   and by something the author never had to write.
2. **A declared guarantee** breaks — caught statically, over every execution the
   graph admits rather than the handful somebody wrote payloads for.
3. **A test scenario** fails — caught empirically, on the inputs that happen to
   be declared.

The ordering puts the expensive step last, so it runs least often: a mutant
killed by the linter costs milliseconds, one that survives costs a full pass of
the suite. Which is the right way round — the graphs worth spending time on are
the ones nothing cheaper could rule out.

`remove-gate` is the operator that earns guarantees their keep. Delete the
approval and a declared `requires` invariant reports that its subject has
vanished; without the declaration, nothing at all notices.

### Credited only with what the mutation broke

Findings are compared against a **baseline** of what the original already fails.

Without that, a workflow that does not lint would hand every one of its mutants
an inherited error and score a perfect 100 — a graph too broken to run reported
as perfectly covered, which is the exact inversion of the point.

What counts as a kill also differs between the two static checks, deliberately:

- **Linter: errors only.** A warning means *"legal but probably not what you
  meant"*, which is a description of every mutant. Counting warnings would let
  each mutation kill itself.
- **Guarantees: `guarantee-uncheckable` counts too.** It is a warning because a
  graph may legitimately be mid-edit — but a declaration reporting that the node
  it was about has vanished is precisely the bug `remove-gate` introduces, and
  [`flowforge verify`](./GUARANTEES.md) already exits non-zero on it.

---

## Nothing is written

Mutants exist in memory. They execute through the engine's own `graphOverride`
in dry-run mode — the facility that already exists for running a graph the
workflow does not hold — so no side-effecting node fires, and the dry-run rows
are deleted once their assertions have been read.

A mutation analysis should leave no trace in a workflow's history, and there are
tests asserting both halves: no execution row left behind, and the saved
definition byte-identical afterwards.

```console
$ flowforge mutants 6f0c…
Mutation testing 6f0c…
  6 plausible bug(s) introduced · checked against 3 scenario(s) and 1 guarantee(s)

        IF THIS WERE THE BUG                                      CAUGHT BY
caught  "Large order?" wired backwards                            a test
caught  "Approve refund" removed — runs straight past the gate    a guarantee
caught  "Tag large" removed — the step never runs                 the linter
MISSED  "Large order?" off by one — 100 became 101                —

1 bug(s) nothing would notice
  · "Large order?" off by one — 100 became 101

  A scenario that asserts on what the workflow *decided* kills these;
  one that asserts only that the run completed does not.

  5/6 caught (83%) · 1 by the linter · 1 by a guarantee · 3 by a test
```

---

## The exit code, and why it passes by default

`flowforge mutants` reports and returns **0** even with survivors. `--strict`
opts into failing.

That is the opposite of most gates here, and the reason is the honest limit of
the technique:

> **An equivalent mutant cannot be killed by anything**, because it does not
> change behaviour — removing a node whose output nothing reads, or shifting a
> threshold no input is near. Identifying them is **undecidable in general**.

So a survivor is *evidence* of a gap, not proof of one. Failing a build on a
number with irreducible noise in it is how a check earns its way out of a
pipeline. The default reports; a team that has read its survivors and knows what
the gate costs can turn it on, and the failure message says plainly that some of
the count may be equivalent.

This is also why the report **names each mutation** rather than only scoring it.
A survivor takes about a second to judge — *"could that actually happen? would I
care?"* — and that judgement is one a person can make and an algorithm cannot.

---

## What it does not do

- **It does not mutate node config beyond thresholds.** Changing a URL or an
  email address produces a mutant every scenario kills trivially (dry-run
  outputs differ) without saying anything about coverage.
- **It does not generate the missing test.** [Path feasibility](./PATHS.md)
  already produces payloads that reach a branch; pairing the two — *"here is the
  survivor, and here is an input that would have caught it"* — is the obvious
  next step and is not this one.
- **It does not run against a candidate graph.** The analysis is about the saved
  workflow's checks. Judging an edit is [preview's](./PREVIEW.md) job.
- **It is bounded.** Sixteen mutants against ten scenarios is already a hundred
  and sixty dry runs, and a report nobody waits for is a report nobody uses.
