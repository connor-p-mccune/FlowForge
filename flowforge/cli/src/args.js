// Tiny argv parser — the CLI's whole surface is positionals plus a handful of
// --flags, so a dependency would be all cost. Supports `--flag value`,
// `--flag=value`, and boolean flags (a --flag followed by another flag, or by
// nothing, is `true`).

const BOOLEAN_FLAGS = new Set([
  'watch', 'help', 'version', 'json', 'strict', 'yes', 'step', 'stop', 'facts', 'suggest',
])

// Flags that may appear more than once and collect their values into an array.
// Everything else keeps last-wins, which is the right default for a scalar —
// but a repeated `--break` silently discarding all but the last would set a
// breakpoint the caller never asked for and skip the ones they did.
const REPEATABLE_FLAGS = new Set(['break'])

function assign(flags, name, value) {
  if (!REPEATABLE_FLAGS.has(name)) {
    flags[name] = value
    return
  }
  if (flags[name] === undefined) flags[name] = [value]
  else flags[name].push(value)
}

function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      assign(flags, body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith('--')) {
      flags[body] = true
    } else {
      assign(flags, body, next)
      i++
    }
  }
  return { positionals, flags }
}

module.exports = { parseArgs }
