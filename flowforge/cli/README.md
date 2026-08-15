# FlowForge CLI

Trigger and watch [FlowForge](../README.md) workflow runs from the terminal —
a thin, **zero-dependency** client for the [public API](../docs/API.md),
built for CI pipelines and quick ops work.

```
$ flowforge trigger 6f0c… --data '{"orderId": 42}' --watch
Run e57a… pending
Poll: /api/v1/executions/e57a…
  succeeded  t1 (trigger-manual)
  succeeded  h1 (action-http) 1.2s
  succeeded  log1 (output-log)
Run completed in 4.0s
```

The process exits `0` only when the run completed — a failed workflow fails
the CI job that triggered it.

## Install

```bash
cd cli && npm link      # puts `flowforge` on your PATH
```

## Authenticate

Mint a token in **Settings → API tokens** (scopes: `trigger`, `read`), then
either:

```bash
# Interactive — verifies the token, then saves ~/.flowforge.json (0600)
flowforge login --url https://your-flowforge-host --token ffp_…

# CI — env vars always win over the file; no login step needed
export FLOWFORGE_URL=https://your-flowforge-host
export FLOWFORGE_TOKEN=ffp_…
```

## Commands

| Command | What it does |
|---|---|
| `flowforge workflows` | List workflows visible to the token (the ID column is what `trigger` takes) |
| `flowforge export <id>` | Print the workflow's portable JSON to stdout — `flowforge export <id> > workflows/sync.json` checks it into git |
| `flowforge workspaces` | List workspaces visible to the token (the ID column is what `import` takes) |
| `flowforge import <ws-id> <file> [--name "…"]` | Create a draft workflow from an exported file — promote definitions between environments (needs the `manage` scope) |
| `flowforge diff <id> <file>` | Compare the **live** workflow against an exported file — exits non-zero on drift, so CI catches the promotion someone forgot (or the hand-edit someone made) |
| `flowforge merge <id> <file> [--yes] [--ours\|--theirs] [--base <v>]` | Three-way merge a file into the live workflow, per config field — keeps both sides' work instead of picking one to lose. Previews unless `--yes`; exits **2** on conflicts ([docs](../docs/MERGE.md)) |
| `flowforge lint <id> [file] [--strict]` | Run the app's linter as a CI gate — over the live workflow, or over an exported file against its target workspace (real secret/variable names, sub-workflow targets); exits non-zero on errors, `--strict` fails warnings too |
| `flowforge verify <id> [--facts] [--suggest]` | Check the workflow's declared path invariants over **every execution the graph admits**; exits non-zero on one that broke *or* one that can no longer be checked ([docs](../docs/GUARANTEES.md)) |
| `flowforge preview <id> <file> [--runs N] [--strict]` | Replay recent runs against a candidate definition — **what would this change do?** Reports by default; `--strict` fails the build on any behaviour change ([docs](../docs/PREVIEW.md)) |
| `flowforge paths <id> [--cover]` | Which branches an input can actually take, and the payload that takes each one; exits non-zero on a **dead branch** (`--cover` also on an untested live one) ([docs](../docs/PATHS.md)) |
| `flowforge debug <id> --break <node>` | Run with breakpoints and report the **resolved** config each node was about to run with — templates substituted, secrets redacted. `--step` traces every node, `--stop` parks the run at the first one |
| `flowforge types <id> [--node <id>] [--json]` | The workflow's inferred data schema — what each node produces and the exact `{{node.path}}` references it offers; exits non-zero on a type error ([docs](../docs/TYPES.md)) |
| `flowforge release <id> [--promote] [--rollback] [--wait N]` | Canary release status — exits **0** promote, **1** roll back, **2** keep waiting, so a pipeline branches on the verdict without parsing a p-value ([docs](../docs/RELEASES.md)) |
| `flowforge search <query> [--limit N]` | Find workflows by name **or by what's inside them** — node labels, config strings, sticky notes ([docs](../docs/API.md#search-workflows)) |
| `flowforge trigger <id> [--data <json>] [--key <k>] [--priority high\|normal\|low] [--watch]` | Start a run; `--key` sets an [`Idempotency-Key`](../docs/API.md#trigger-a-workflow) so retries are safe; `--priority` picks the queue lane |
| `flowforge pause <id>` | Kill switch — hold **all** new runs (manual, API, webhook, schedule, error-handler) while in-flight runs settle; wrap a deploy window so no cron tick fires into a half-migrated system (needs the `manage` scope) |
| `flowforge unpause <id>` | Release the pause and accept runs again (needs the `manage` scope) |
| `flowforge runs <id> [--limit N]` | A workflow's recent runs |
| `flowforge deps <id>` | Cross-workflow impact analysis — what a workflow calls (sub-workflow/for-each nodes, error handler) and what calls it; exits non-zero on a stale reference cycle |
| `flowforge insights <id> [--limit N]` | Duration percentiles, success rate, throughput, and anomalous runs ([docs](../docs/INSIGHTS.md)) |
| `flowforge regressions <id> [--limit N]` | When the duration changed, which deploy landed in the gap, and which step moved; exits non-zero on a change **for the worse** ([docs](../docs/INSIGHTS.md#when-it-changed-and-what-changed-with-it)) |
| `flowforge forecast <id>` | Predicted next-run duration and bottleneck ([docs](../docs/INSIGHTS.md#forecasting-the-next-run)) |
| `flowforge schedule <id> [--count N]` | Upcoming scheduled run times, computed from the workflow's cron (UTC) |
| `flowforge check <id> [--min-success-rate PCT] [--max-p95 SECONDS] [--strict]` | Gate CI on workflow health — exits non-zero on an SLA breach or a degrading trend |
| `flowforge test <id> [--junit <file>]` | Run the workflow's test scenarios (FXL assertions over a dry-run) — exits non-zero on any failure; `--junit` writes a report CI renders natively |
| `flowforge run <exec-id> [--watch]` | One run with its steps |
| `flowforge compare <exec-id> <exec-id>` | Diff two runs of a workflow node by node — status changes, duration deltas, output changes ([docs](../docs/INSIGHTS.md#comparing-two-runs)) |
| `flowforge lineage <id> [--node <id>] [--strict]` | Where data comes from and where it leaves — provenance, impact, and caller-controlled sinks; `--strict` gates CI ([docs](../docs/LINEAGE.md)) |
| `flowforge cancel <exec-id>` | Stop a queued or running run (cooperative) |
| `flowforge resume <exec-id> [--watch]` | Continue a failed/cancelled run — succeeded steps are reused, only the failed part re-runs |
| `flowforge rollback <exec-id> [--yes]` | Undo a failed run's side effects by running its compensating actions, newest first — previews unless `--yes`, exits non-zero on a partial unwind ([docs](../docs/ROLLBACK.md)) |
| `flowforge approvals [--status pending]` | Runs waiting on a human, across your workspaces |
| `flowforge approve <id> [--note "…"]` | Wave a paused run through its approval gate (needs the `approve` scope) |
| `flowforge reject <id> [--note "…"]` | Send it down the rejected branch instead |

`--watch` polls every 2 seconds (`--interval <seconds>` to change) and prints
each step transition once. `NO_COLOR=1` (or piping stdout) disables colors.

## A CI job in three lines

```yaml
- run: npx --prefix cli flowforge trigger $WORKFLOW_ID --key "$GITHUB_RUN_ID" --watch
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}
```

Using the CI run id as the idempotency key means a re-run of the job can
never double-trigger the workflow.

## Vet a definition before importing it

`lint` runs the app's own workflow linter from the terminal. Pointed at a
file, it checks an exported definition against the **target** workflow's
workspace — do the `{{secrets.*}}` and `{{vars.*}}` names it references
exist there? are its sub-workflow targets deployed? — so a broken promotion
is caught before the import, not at the first 3am run:

```yaml
- run: npx --prefix cli flowforge lint $WORKFLOW_ID workflows/sync.json --strict
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}
```

Without a file it lints the live workflow. Errors always fail the job;
`--strict` fails warnings (unreachable nodes, half-wired branches) too.

## Gate on what the graph can never do

`lint` answers *will this run?*. `verify` answers a question no amount of
linting reaches — *does it still do what its author swore it did?* — by
checking the workflow's declared path invariants against every execution the
graph admits:

```console
$ flowforge verify 6f0c…
✗ Charge card never runs unless Approve ran first
    Run by hand → Charge card reaches Charge card without Approve
    counterexample: manual → charge

1 of 2 guarantees no longer hold
```

Somebody added a manual trigger for testing and wired it straight at the
charge. Every node still lints, every type still checks, and the approval is
now optional. Both commands belong in a pipeline because they fail on
different things:

```yaml
- run: npx --prefix cli flowforge lint $WORKFLOW_ID --strict
- run: npx --prefix cli flowforge verify $WORKFLOW_ID
```

A guarantee that can no longer be **checked** fails the build exactly like one
that broke. Delete the approval node and every invariant about it stops
failing — a green pipeline forever, guarding nothing.

`--facts` adds what is true of the graph regardless of what anyone declared
(which nodes every run executes, where the decisions are); `--suggest` lists
the invariants that hold today and look deliberate, which is the shortest path
from *no guarantees declared* to a useful set.

## Gate on the branch nothing has ever run

`lint` and `verify` both reason about the graph. `paths` reasons about the
**data**, which is the only way to see a branch that is wired, typed, reachable
in the graph, and dead:

```console
$ flowforge paths 6f0c…
Route (switch)
  ✓ refund  — drivable
      trigger: {"kind":"refund"}
  ✗ narrow
      contradicts Route → wide
  ✓ default  — drivable
      trigger: {"kind":"v0"}

2/3 branches reachable · 2 drivable from a trigger payload

1 branch no input can take.
```

The second case sits behind a wider one that already matched everything it
would have, so nothing has ever taken it and nothing ever will — and the
finding names the case it lost to rather than leaving that to be worked out.

The `trigger:` lines are the other half. Each one is a payload that provably
drives its branch, which is what makes generating a scenario per branch
possible at all (the canvas's 🧪 Tests panel writes them straight into the
suite). `--cover` turns that into a build rule:

```yaml
- run: npx --prefix cli flowforge paths $WORKFLOW_ID --cover
```

A dead branch always fails. `--cover` additionally fails when a *live* branch
has no payload that can drive it in test mode — deliberately opt-in, because a
workflow with an approval gate can never satisfy it: the rejected side is real
and untestable in dry-run mode, which the output says rather than hides.

## Review a promotion by what it does, not by what it says

`diff` says the definition changed. `lint` says the new one will run, `verify`
that it still keeps its promises, `paths` that every branch is live. None of
them says what the change **does** — which is the question a reviewer has, and
the one a pipeline can now answer before merging:

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

Each replay is a dry run against a definition the workflow does not hold, with
every node that reaches outside FlowForge settled from **that run's own
recorded output** — so nothing fires, nothing is stored, and a routing
difference is attributable to the change rather than to test mode simulating a
response. The corollary is the scope: it answers what the graph does with the
same data, not what a different API returns.

Behaviour changing is the *expected* outcome of a deploy, so this reports and
exits `0`. `--strict` is what turns it into a build failure, for the promotion
that claims to be inert:

```yaml
- run: npx --prefix cli flowforge preview $WORKFLOW_ID workflows/sync.json --strict
```

A refactor, a rename, or a config-only edit all claim to change nothing
observable. That is now a claim CI can check.

## See what a node was actually about to send

Adding an output node to find out what an HTTP node posts means editing the
workflow, deploying it, running it, reading it, and taking it out again — which
changes the thing being investigated. `debug` doesn't touch the graph:

```console
$ flowforge debug 6f0c… --break charge-card
run 4e9a…

▸ Charge card (charge-card)
  about to run with:
    {
      "url": "https://api.acme.com/v1/charges/ord-8891",
      "method": "POST",
      "headers": { "Authorization": "Bearer ••••••" }
    }
  received:
    { "orderId": "ord-8891", "amount": 4500 }

status completed
```

The run pauses before each named node, the command prints what it was about to
do — every `{{…}}` already resolved, every secret already redacted — and
resumes it. A breakpoint polled and immediately released is a **trace point**.

`--step` traces every node instead of named ones. `--stop` parks the run at the
first breakpoint and prints the id to resume it with, for when you want to hold
it open and change something. Exits non-zero unless the run completed.

Breakpoints attach to the run this command starts, never to the workflow — so a
schedule tick or a webhook delivery of the same workflow can't hit one.

## Ask what a node actually produces

`types` prints the workflow's inferred schema — every node's output shape,
derived from the runners' contracts and propagated across the graph, so it
holds for a workflow that has never run. `--node` narrows to one node and
lists its references in the form you paste into a config:

```console
$ flowforge types 6f0c… --node http-1
http-1
  in  { triggered: boolean, … }
  out { status: number, body: any }

  references:
    {{http-1.status}} number
    {{http-1.body}} any
```

`--json` prints the machine-readable lattice, which is the useful form for
diffing a schema across a promotion.

## Ship a canary from CI

`release` reports the running canary and exits by its recommendation, so the
pipeline reads as the decision rather than as arithmetic:

```yaml
- run: |
    npx --prefix cli flowforge release $WORKFLOW_ID --wait 900
    case $? in
      0) npx --prefix cli flowforge release $WORKFLOW_ID --promote ;;
      1) npx --prefix cli flowforge release $WORKFLOW_ID --rollback "canary regressed"; exit 1 ;;
      2) echo "No verdict yet — leaving the canary running." ;;
    esac
```

Exit **2** for "not enough evidence yet" is deliberate and distinct from 1: a
job that treated it as failure would roll back every healthy release that
happens to be young.

## Gate a deploy on definition drift

If workflow definitions live in git (`flowforge export` → code review →
`flowforge import`), `diff` is the check that the loop actually closed: it
compares the live workflow against the file and exits non-zero when they
differ — a promotion that never ran, or a hand-edit made in the app that
nobody exported back.

```yaml
- run: npx --prefix cli flowforge diff $WORKFLOW_ID workflows/sync.json
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}
```

The report reads from the file's perspective (`+` exists live only, `-` is in
the file but gone live, `~` changed), and moving nodes around the canvas is
not drift — only meaningful changes count.

## Gate a deploy on workflow health

`check` turns the [insights](../docs/INSIGHTS.md) into a pass/fail gate: it exits
non-zero when the workflow is breaching an SLA target or trending slower, so a
pipeline can refuse to ship on top of a degrading automation.

```yaml
- run: npx --prefix cli flowforge check $WORKFLOW_ID --max-p95 5 --min-success-rate 95
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}
```

With no thresholds passed it falls back to the workflow's own SLA targets;
`--strict` also fails on any anomalous run in the window.

## Gate a deploy on workflow test scenarios

Where `check` gates on *past* health, `test` gates on *correctness now*: it runs
the workflow's [test scenarios](../docs/ARCHITECTURE.md#workflow-test-scenarios)
— each a trigger payload plus FXL assertions over the resulting dry-run — and
exits non-zero if any assertion fails, printing which one.

```yaml
- run: npx --prefix cli flowforge test $WORKFLOW_ID
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}
```

An empty suite is a skip (exit 0) — an untested workflow isn't broken, just
unverified.

## Development

```bash
npm test    # node:test against a stub API server — no FlowForge needed
```
