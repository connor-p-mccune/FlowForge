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
| `flowforge lint <id> [file] [--strict]` | Run the app's linter as a CI gate — over the live workflow, or over an exported file against its target workspace (real secret/variable names, sub-workflow targets); exits non-zero on errors, `--strict` fails warnings too |
| `flowforge types <id> [--node <id>] [--json]` | The workflow's inferred data schema — what each node produces and the exact `{{node.path}}` references it offers; exits non-zero on a type error ([docs](../docs/TYPES.md)) |
| `flowforge release <id> [--promote] [--rollback] [--wait N]` | Canary release status — exits **0** promote, **1** roll back, **2** keep waiting, so a pipeline branches on the verdict without parsing a p-value ([docs](../docs/RELEASES.md)) |
| `flowforge search <query> [--limit N]` | Find workflows by name **or by what's inside them** — node labels, config strings, sticky notes ([docs](../docs/API.md#search-workflows)) |
| `flowforge trigger <id> [--data <json>] [--key <k>] [--priority high\|normal\|low] [--watch]` | Start a run; `--key` sets an [`Idempotency-Key`](../docs/API.md#trigger-a-workflow) so retries are safe; `--priority` picks the queue lane |
| `flowforge pause <id>` | Kill switch — hold **all** new runs (manual, API, webhook, schedule, error-handler) while in-flight runs settle; wrap a deploy window so no cron tick fires into a half-migrated system (needs the `manage` scope) |
| `flowforge unpause <id>` | Release the pause and accept runs again (needs the `manage` scope) |
| `flowforge runs <id> [--limit N]` | A workflow's recent runs |
| `flowforge deps <id>` | Cross-workflow impact analysis — what a workflow calls (sub-workflow/for-each nodes, error handler) and what calls it; exits non-zero on a stale reference cycle |
| `flowforge insights <id> [--limit N]` | Duration percentiles, success rate, throughput, and anomalous runs ([docs](../docs/INSIGHTS.md)) |
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
