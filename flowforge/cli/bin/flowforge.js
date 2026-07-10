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
  trigger: require('../src/commands/trigger'),
  runs: require('../src/commands/runs'),
  run: require('../src/commands/run'),
  cancel: require('../src/commands/cancel'),
}

const USAGE = `flowforge — FlowForge from the terminal

Usage:
  flowforge login --url <server> --token <ffp_…>   Store credentials (~/.flowforge.json)
  flowforge workflows                              List workflows visible to the token
  flowforge trigger <workflow-id> [--data <json>] [--key <idempotency-key>] [--watch]
  flowforge runs <workflow-id> [--limit N]         Recent runs for a workflow
  flowforge run <execution-id> [--watch]           One run with its steps
  flowforge cancel <execution-id>                  Stop a queued or running run

Configuration:
  FLOWFORGE_URL / FLOWFORGE_TOKEN env vars override the login file — set them
  as CI secrets and skip login entirely. NO_COLOR disables colors.

Exit codes:
  0 success · 1 error, or a watched run that failed/was cancelled`

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
