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
  search: require('../src/commands/search'),
  export: require('../src/commands/export'),
  import: require('../src/commands/import'),
  trigger: require('../src/commands/trigger'),
  runs: require('../src/commands/runs'),
  insights: require('../src/commands/insights'),
  forecast: require('../src/commands/forecast'),
  schedule: require('../src/commands/schedule'),
  check: require('../src/commands/check'),
  test: require('../src/commands/test'),
  run: require('../src/commands/run'),
  compare: require('../src/commands/compare'),
  cancel: require('../src/commands/cancel'),
  resume: require('../src/commands/resume'),
  approvals: require('../src/commands/approvals'),
  approve: require('../src/commands/respond').approve,
  reject: require('../src/commands/respond').reject,
}

const USAGE = `flowforge — FlowForge from the terminal

Usage:
  flowforge login --url <server> --token <ffp_…>   Store credentials (~/.flowforge.json)
  flowforge workflows                              List workflows visible to the token
  flowforge workspaces                             List workspaces (import targets)
  flowforge search <query> [--limit N]             Find workflows by name or by what's inside them
  flowforge export <workflow-id>                   Print the portable workflow JSON (pipe to a file)
  flowforge import <workspace-id> <file> [--name]  Create a draft workflow from an exported file
  flowforge trigger <workflow-id> [--data <json>] [--key <idempotency-key>] [--priority high|normal|low] [--watch]
  flowforge runs <workflow-id> [--limit N]         Recent runs for a workflow
  flowforge insights <workflow-id> [--limit N]     Duration percentiles, success rate, anomalies
  flowforge forecast <workflow-id>                 Predicted next-run duration and bottleneck
  flowforge schedule <workflow-id> [--count N]     Upcoming scheduled run times (UTC)
  flowforge check <workflow-id> [--strict]         Gate CI on workflow health (exits non-zero on a breach)
  flowforge test <workflow-id> [--junit <file>]    Run the workflow's test scenarios (exits non-zero on failure)
  flowforge run <execution-id> [--watch]           One run with its steps
  flowforge compare <execution-id> <execution-id>  Diff two runs node by node
  flowforge cancel <execution-id>                  Stop a queued or running run
  flowforge resume <execution-id> [--watch]        Re-run only the failed part of a run
  flowforge approvals [--status pending]           Runs waiting on a human
  flowforge approve <approval-id> [--note "…"]     Wave a paused run through
  flowforge reject <approval-id> [--note "…"]      Send it down the rejected branch

Configuration:
  FLOWFORGE_URL / FLOWFORGE_TOKEN env vars override the login file — set them
  as CI secrets and skip login entirely. NO_COLOR disables colors.

Exit codes:
  0 success · 1 error, a watched run that failed/was cancelled, or a
  'check' whose workflow breached its health thresholds`

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
  // login builds its own client from the flags; everything else needs
  // credentials up front.
  if (command !== 'login') {
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
