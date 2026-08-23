#!/usr/bin/env node
// FlowForge CLI — the public API (/api/v1) from the terminal. Commands return
// an exit code; anything they throw is printed as a one-line error. `trigger
// --watch` and `run --watch` exit non-zero unless the run completed, so a
// failed workflow fails the CI job that triggered it.

const { parseArgs } = require('../src/args')
const { resolveConfig } = require('../src/config')
const { createClient } = require('../src/api')
const { red } = require('../src/format')

const COMMANDS = {
  login: require('../src/commands/login'),
  workflows: require('../src/commands/workflows'),
  workspaces: require('../src/commands/workspaces'),
  audit: require('../src/commands/audit'),
  search: require('../src/commands/search'),
  export: require('../src/commands/export'),
  import: require('../src/commands/import'),
  keygen: require('../src/commands/keygen'),
  sign: require('../src/commands/sign'),
  diff: require('../src/commands/diff'),
  merge: require('../src/commands/merge'),
  lint: require('../src/commands/lint'),
  debug: require('../src/commands/debug'),
  verify: require('../src/commands/verify'),
  paths: require('../src/commands/paths'),
  preview: require('../src/commands/preview'),
  types: require('../src/commands/types'),
  lineage: require('../src/commands/lineage'),
  effects: require('../src/commands/effects'),
  release: require('../src/commands/release'),
  trigger: require('../src/commands/trigger'),
  pause: require('../src/commands/pause'),
  unpause: require('../src/commands/resume-workflow'),
  runs: require('../src/commands/runs'),
  backfill: require('../src/commands/backfill'),
  deps: require('../src/commands/deps'),
  insights: require('../src/commands/insights'),
  regressions: require('../src/commands/regressions'),
  forecast: require('../src/commands/forecast'),
  contention: require('../src/commands/contention'),
  drift: require('../src/commands/drift'),
  schedule: require('../src/commands/schedule'),
  check: require('../src/commands/check'),
  test: require('../src/commands/test'),
  run: require('../src/commands/run'),
  compare: require('../src/commands/compare'),
  cancel: require('../src/commands/cancel'),
  resume: require('../src/commands/resume'),
  rollback: require('../src/commands/rollback'),
  approvals: require('../src/commands/approvals'),
  approve: require('../src/commands/respond').approve,
  reject: require('../src/commands/respond').reject,
}

const OFFLINE = new Set(['login', 'keygen', 'sign'])

const USAGE = `flowforge — FlowForge from the terminal

Usage:
  flowforge login --url <server> --token <ffp_…>   Store credentials (~/.flowforge.json)
  flowforge workflows                              List workflows visible to the token
  flowforge workspaces                             List workspaces (import targets)
  flowforge audit <ws-id> [--verify] [--action <f>] Audit log + hash-chain verification (exits non-zero on a broken chain)
  flowforge search <query> [--limit N]             Find workflows by name or by what's inside them
  flowforge export <workflow-id> [--flow]          Print the portable workflow JSON — or --flow for the reviewable text form (pipe to a file)
  flowforge import <workspace-id> <file> [--name]  Create a draft workflow from an exported .json or .flow file
  flowforge keygen [--out <prefix>]                Mint an Ed25519 signing key pair (offline; never touches a server)
  flowforge sign <file> --key <private.key>        Sign an exported definition — or --check <public.pub> to verify one
  flowforge diff <workflow-id> <file>              Compare the live workflow against an exported file (exits non-zero on drift)
  flowforge merge <workflow-id> <file> [--yes]     Three-way merge a file into the live workflow (exits 2 on conflicts)
  flowforge lint <workflow-id> [file] [--strict]   Lint the live workflow — or an exported file against its workspace (exits non-zero on errors)
  flowforge verify <id> [--facts] [--suggest]      Check declared path invariants over every execution the graph admits (exits non-zero on a break)
  flowforge paths <workflow-id> [--cover]          Which branches an input can take, and what payload takes them (exits non-zero on a dead branch)
  flowforge preview <id> <file> [--runs N] [--strict] Replay recent runs against a candidate definition — what would this change do? (--strict fails on any behaviour change)
  flowforge debug <id> --break <node> [--step]     Run with breakpoints and report what each node was about to do (--stop parks it)
  flowforge types <workflow-id> [--node <id>]      Inferred data schema per node — what each one produces (exits non-zero on a type error)
  flowforge lineage <id> [--node <id>] [--strict]  Where data comes from and where it leaves — provenance, impact, and taint
  flowforge effects <id> [--ungated]               What a run can do to the outside world, and what has to be true first (--ungated fails on an effect with no gate)
  flowforge release <id> [--promote|--rollback]   Canary release status — exits 0 promote, 1 roll back, 2 keep waiting
  flowforge trigger <workflow-id> [--data <json>] [--key <idempotency-key>] [--priority high|normal|low] [--watch]
  flowforge pause <workflow-id>                    Hold all new runs (kill switch) — needs a manage token
  flowforge unpause <workflow-id>                  Release the pause and accept runs again
  flowforge runs <workflow-id> [--limit N]         Recent runs for a workflow
  flowforge backfill <id> --from <iso|7d> [--yes]  Re-run a schedule over a past window (previews unless --yes)
  flowforge deps <workflow-id>                     What a workflow calls and what calls it (exits non-zero on a reference cycle)
  flowforge insights <workflow-id> [--limit N]     Duration percentiles, success rate, anomalies
  flowforge regressions <id> [--limit N]           When the duration changed, and which deploy did it (exits non-zero on a regression)
  flowforge forecast <id> [--cap N]                Predicted next-run duration, bottleneck, and what the parallelism cap costs
  flowforge contention <exec-id> [--max <ratio>]   Where a run's time went — work vs waiting for a slot (exits non-zero over the budget)
  flowforge drift <workflow-id> [--strict]         Has what this workflow *produces* changed? Fields, null rates, distributions (--strict fails the build)
  flowforge schedule <workflow-id> [--count N]     Upcoming scheduled run times (UTC)
  flowforge check <workflow-id> [--strict]         Gate CI on workflow health (exits non-zero on a breach)
  flowforge test <workflow-id> [--junit <file>]    Run the workflow's test scenarios (exits non-zero on failure)
  flowforge run <execution-id> [--watch]           One run with its steps
  flowforge compare <execution-id> <execution-id>  Diff two runs node by node
  flowforge cancel <execution-id>                  Stop a queued or running run
  flowforge resume <execution-id> [--watch]        Re-run only the failed part of a run
  flowforge rollback <execution-id> [--yes]        Undo a failed run's side effects (previews unless --yes)
  flowforge approvals [--status pending]           Runs waiting on a human
  flowforge approve <approval-id> [--note "…"]     Wave a paused run through
  flowforge reject <approval-id> [--note "…"]      Send it down the rejected branch

Configuration:
  FLOWFORGE_URL / FLOWFORGE_TOKEN env vars override the login file — set them
  as CI secrets and skip login entirely. NO_COLOR disables colors.

Exit codes:
  0 success · 1 error, a watched run that failed/was cancelled, a
  'check' whose workflow breached its health thresholds, a 'diff'
  that found drift, an 'audit' whose chain failed verification, a
  'contention' over its --max budget, or a 'rollback' that only
  partly unwound (the world is inconsistent in a known way — a
  pipeline should stop)
  2 'release' — the canary has no verdict yet (keep waiting), and
    'merge' — the merge conflicts and needs a person. Distinct from 1
    on purpose: a pipeline that treats "not enough evidence" as
    failure rolls back every healthy young release, and one that
    treats "needs review" as failure can't tell a colleague's edit
    from an outage.`

async function main() {
  const argv = process.argv.slice(2)
  const { positionals, flags } = parseArgs(argv)
  const command = positionals.shift()

  if (flags.version) {
    console.log(require('../package.json').version)
    return 0
  }
  if (!command || flags.help || command === 'help') {
    console.log(USAGE)
    return command ? 0 : 1
  }
  const handler = COMMANDS[command]
  if (!handler) {
    console.error(red(`Unknown command "${command}".`))
    console.log(USAGE)
    return 1
  }

  const ctx = { log: (line) => console.log(line) }
  // Commands that talk to no server. `login` builds its own client from the
  // flags; `keygen` and `sign` are offline on purpose — a signing key that has
  // been near a server is a signing key somebody has to reason about, and the
  // approval has to happen where the review happens. Requiring credentials for
  // them would be a lie about what they do.
  if (!OFFLINE.has(command)) {
    ctx.api = createClient(resolveConfig())
  }
  return handler({ positionals, flags }, ctx)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(red(err.message))
    process.exitCode = 1
  })
