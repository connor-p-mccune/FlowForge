# Querying run history

FlowForge has a lot of reports, and each one answers a *fixed* question well:

| | Answers |
|---|---|
| [Insights](./INSIGHTS.md) | How long does this workflow take, and which runs were anomalous? |
| [Regressions](./INSIGHTS.md#when-it-changed-and-what-changed-with-it) | When did it get slower, and which deploy did it? |
| [Drift](./DRIFT.md) | Has what it *produces* changed? |
| [Capacity](./CAPACITY.md) | Is the concurrency cap right? |

None of them answers the question somebody actually has during an incident,
because that question is always specific and never the one anybody anticipated:

> **Which runs last week failed at the charge step with a 5xx, for orders over a
> thousand?**

Today that is a SQL prompt and a `json_extract` incantation — which makes it a
question only somebody with database access can ask, at exactly the moment when
the person who needs the answer is not that person.

The surfaces are `flowforge query <id> "<predicate>"` and
`POST /api/v1/workflows/:id/query`.

---

## FXL is the query language

Not a new one. The predicate is [FXL](./EXPRESSIONS.md) — the same expression
language that powers condition nodes and the Filter node, evaluated against a
scope describing one run.

```bash
flowforge query 6f0c… 'status == "failed" and steps.charge.output.status >= 500'
flowforge query 6f0c… 'durationMs > 60000 and trigger.order.total > 1000'
flowforge query 6f0c… 'lower(steps.notify.output.channel) in ["email", "sms"]'
```

Three things follow from reusing it rather than inventing a query dialect:

- **Nothing new to learn.** Anybody who has written a condition on the canvas
  can already write a query.
- **The whole stdlib works** — `lower`, `contains`, `len`, `matches`, `first` —
  because it is the same evaluator, not a reimplementation that would drift.
- **There is one set of semantics to reason about**, which matters more than it
  sounds. See the sharp edge below.

The scope:

| | |
|---|---|
| `id`, `status`, `triggerType`, `priority` | the run |
| `createdAt`, `startedAt`, `finishedAt` | ISO-8601 UTC strings |
| `durationMs`, `waitMs` | computed; `null` while a run is unfinished |
| `trigger.…` | the recorded trigger payload |
| `steps.<nodeId>.{status,type,durationMs,error,input,output}` | per step |

---

## The planner, and the one guarantee it rests on

Scanning every run of a busy workflow to evaluate a predicate that could have
been an indexed `WHERE status = 'failed'` is the difference between a query
somebody uses and one they stop running. So conjuncts that map onto execution
columns are **pushed into SQL**.

Predicate pushdown is where query engines get subtly wrong answers. The design
here removes the risk rather than managing it:

> **Every conjunct is evaluated by FXL regardless of whether it was pushed.**
> The SQL clauses only ever narrow the *candidate set*. A pushdown bug can
> therefore cost speed and can never change the answer.

That reduces soundness to a single obligation — *the SQL must never remove a row
FXL would have kept* — and it is a real obligation here, not a formality.

### Why a naive pushdown would be wrong

FXL's comparison rules are its own. `compare()` falls back to **string**
comparison whenever either side is not numeric:

```
undefined >= 400   →   "undefined" >= "400"   →   true
null != "failed"   →   !looseEquals(null, …)  →   true
```

A `WHERE json_extract(...) >= 400` drops the first. A `WHERE status != 'failed'`
drops the second, because SQL's `NULL != 'x'` is `NULL`. Both remove rows FXL
keeps.

So **every emitted clause is widened with `OR <col> IS NULL`**. One rule, applied
uniformly, rather than a per-operator argument about how three-valued logic lines
up with FXL's coercions — one of those arguments would eventually be wrong.

Three more rules follow the same principle:

- **Type-matched literals only.** SQLite's type affinity makes
  `text_column > 20260801` unconditionally true, which FXL does not agree with.
  A number compared to a text column is simply not pushed.
- **Numeric bounds are slackened by 1 ms.** `durationMs` is pushed as julianday
  arithmetic, and the float round-trip has sub-millisecond error. Widening the
  bound absorbs it, again in the safe direction.
- **Nothing under `trigger.` or `steps.` is pushed** — not only for the coercion
  reason, but because those rows have to be loaded to evaluate anyway, so a
  correlated subquery would buy nothing.

### Positive position only

A conjunct is pushable only on the top-level `and` spine. Under a `not`, an `or`
or a conditional, narrowing the candidate set is no longer the same as narrowing
the result — a clause that is a filter in one position is the opposite in
another.

`--explain` says so out loud, because "no pushdown" is the difference between an
indexed lookup and reading every run a workflow has ever had:

```console
$ flowforge query 6f0c… 'status == "failed" and steps.charge.output.status >= 500' --explain
WHEN                 RUN       STATUS  TOOK   QUEUED
2026-08-01 10:00:00  a1b2c3d4  failed  5.0s   2.0s

  1 match(es) from 240 run(s) scanned

Plan
  narrowed in SQL by status == "failed"
  step rows loaded per candidate run
```

### Lazy step loading

Step rows are read only when the predicate mentions `steps`, decided by walking
the AST for the identifier. On a workflow with a dozen nodes that is the
difference between one query and thousands.

---

## One sharp edge, kept on purpose

The same string fallback that makes the pushdown delicate is visible to whoever
writes the query:

```
steps.charge.output.status >= 500
```

also matches every run that has **no charge step at all**, because
`undefined >= 500` compares `"undefined"` against `"500"`.

That is surprising the first time, and it is deliberately not fixed here. It is
exactly what a condition node does with the same expression; giving queries their
own comparison rules would leave the product with two dialects of one language,
which is a worse problem than a sharp edge that can be documented. There is a
test that pins the behaviour so it stays intentional.

The idiom is to say what you mean, and FXL already has the operator — `in` on an
object is a `hasOwnProperty` test:

```
"charge" in steps and steps.charge.output.status >= 500
```

---

## Exit codes, and why a search returns 1

| | |
|---|---|
| `0` | runs matched |
| `1` | nothing matched |
| `2` | the predicate did not parse |

Returning non-zero for an empty result reads oddly for a search until you notice
what it makes possible:

```bash
flowforge query "$WF" 'status == "failed" and createdAt > "2026-08-01"' && page-oncall
```

A query language whose exit code carries the answer composes with everything
else in a pipeline. And separating `2` from `1` is the distinction `grep` gets
right and most tools do not: *no results* and *you typed it wrong* need different
responses from a script, and collapsing them turns a typo into a silent all-clear.

A syntax error carries the character position, so the CLI puts a caret under it
rather than making somebody count brackets.

---

## What it does not do

- **It does not aggregate.** No `count`, no `group by`, no `order by` beyond
  newest-first. This finds runs; the reports above compute statistics. A query
  engine that grew aggregation would be re-answering the fixed questions worse.
- **It does not join across workflows.** One workflow's history at a time, which
  is also the authorisation boundary.
- **It scans a bounded number of rows** and says `truncated: true` rather than
  answering from a prefix as though it were complete. A full scan inside a
  synchronous SQLite call is a stalled server, and the honest answer to "that
  was too much" is to say so.
- **It does not index run *content*.** A predicate over `steps.…` reads the step
  rows of every candidate. Making that fast would mean materialising an index
  over recorded outputs, which is a real feature and a different one.
