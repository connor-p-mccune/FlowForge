# Deploy preview

What a change would have done to the runs that already happened.

```console
$ flowforge preview 6f0c… workflows/sync.json
3 of 20 replayed runs would behave differently.

~ e57a…  2026-01-12T09:00:00.000Z
    Large order? routes true → false
    now runs: Standard shipping
    no longer runs: Priority shipping
…

1 status change · 3 rerouted · 1 node newly running · 1 no longer running
```

---

## The gap this closes

Every gate on a deploy in FlowForge is **static**.

| Check | Question |
|---|---|
| [The linter](./ARCHITECTURE.md#static-analysis-the-linter) | is the graph well-formed? |
| [Types](./TYPES.md) | does the data line up? |
| [Policies](./POLICIES.md) | is this allowed here? |
| [Guarantees](./GUARANTEES.md) | do the author's invariants still hold? |
| [Paths](./PATHS.md) | is every branch reachable? |

All five are worth having. None of them answers the question the person with
their cursor over **Deploy** actually has:

> what would this change have done to last week's traffic?

A [canary](./RELEASES.md) answers it — eventually, with real traffic and real
consequences. This answers it beforehand, against traffic that already happened,
with none.

---

## The method

For each of the last N real runs: take its recorded trigger payload, replay it
against the **candidate** graph in dry-run mode, and compare the path it takes
against the path the run really took.

The load-bearing detail is **what runs for real during that replay**.

A plain dry run replaces an HTTP call with a "would send" preview, so a
condition branching on `status == 200` behaves differently for a reason that has
nothing to do with the edit — the comparison would be dominated by test-mode
artefacts and would report a difference for every run.

So every node whose work reaches outside FlowForge is **settled from the
original run's own recorded output**:

| Replayed for real | Settled from the recording |
|---|---|
| condition, switch, validate | HTTP, email, Slack, delay |
| filter, map, aggregate, transform | the AI nodes |
| the trigger | sub-workflow, for-each |
| | approval, wait-for-callback |

What executes is exactly the graph's **decision logic**, which is the thing
under test. That is what makes a routing difference attributable to the change
— the only claim the feature makes.

A node the original run never reached has no recording to lend it and simply
executes in dry-run mode. That is correct rather than a gap: a change that
routes traffic into a previously dark branch is one of the differences worth
reporting.

---

## What it does not claim

It answers **what the graph does with the same data**, not what a different API
returns.

Point an HTTP node at a new URL and the preview keeps the old response, because
nothing here can know the new one. Stated plainly rather than hidden, because a
preview that invented a response would be worse than no preview at all: its
findings would look exactly like the true ones.

---

## Boundaries

- **Dry-run only, structurally.** The engine refuses both a graph override and
  stubbed outputs outside a dry run, so a preview cannot fire a real effect
  however it is called. The [node test bench](./ARCHITECTURE.md#the-node-test-bench)
  makes the same trade one node at a time.
- **The runs are a means, not a record.** Each replay's execution row is deleted
  once its steps have been read. A preview is a question, and leaving fifty rows
  in run history every time somebody asks one would make run history useless —
  the opposite of what this exists for.
- **Bounded twice**, by run count (50 max, 20 by default) and by wall time,
  because it is a synchronous request that executes graphs. An unfinished
  preview reports `truncated: true` rather than looking clean.
- **Failed runs are replayed too.** "This change makes that stop failing" is
  exactly as interesting as the reverse, and excluding them would hide the half
  of the answer somebody is usually hoping for.

One engine detail is worth recording because it was found by a hang rather than
by reasoning. The scheduler inserts a launched task into its in-flight set
*after* starting it, which is safe only because every runner is `async` and
awaited — a task body that completed without ever yielding would delete its own
entry before the entry existed and leave the scheduler spinning on a settled
promise forever. The first implementation of stubbing short-circuited the runner
call and did exactly that. The stub is now expressed as a synthetic `stub`
fault, so it travels the same path every other node does.

---

## Where it runs

| Surface | |
|---|---|
| 🔮 Preview panel | replays against the canvas on screen, on a button rather than a debounce — it is the one analysis panel that is not a pure function of the graph |
| `flowforge preview <id> <file>` | the promotion gate; `--strict` fails the build on any behaviour change |
| `POST /api/v1/workflows/:id/preview` | `read` scope, because nothing survives the call |

### Why `--strict` is opt-in

Behaviour changing is the **expected** outcome of a deploy. A gate that failed
on any difference would fail on every real change, and would be switched off
within a week — the same reasoning that keeps the type checker silent about
anything it cannot prove.

So the default reports and exits `0`, which is right for a step whose job is to
put the consequences in front of a reviewer. `--strict` is for the promotion
that claims to be **inert**:

```yaml
- run: npx --prefix cli flowforge preview $WORKFLOW_ID workflows/sync.json --strict
```

A refactor, a rename, a config-only edit all claim to change nothing
observable. That is now a claim CI can check.

A replay that *errored* fails either way, because there the preview could not
answer at all — and a gate that passes because it could not look is worse than
no gate.
