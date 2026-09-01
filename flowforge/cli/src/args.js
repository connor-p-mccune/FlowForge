// Tiny argv parser — the CLI's whole surface is positionals plus a handful of
// --flags, so a dependency would be all cost. Supports `--flag value`,
// `--flag=value`, and boolean flags (a --flag followed by another flag, or by
// nothing, is `true`).

// Flags that never take a value. A flag missing from this set is only treated
// as boolean when nothing follows it, so `--deep 6f0c…` reads the workflow id
// as the flag's value and leaves the command with no positional at all — it
// prints its usage line and exits, which looks like the user's mistake.
//
// The rule for adding one: if no code path anywhere reads its value, it belongs
// here. `--rollback` and `--recent` are deliberately absent, because both take
// an optional value and both are read as a string when given one.
const BOOLEAN_FLAGS = new Set([
  'watch', 'help', 'version', 'json', 'strict', 'yes', 'step', 'stop', 'facts', 'suggest', 'cover',
  'all', 'deep', 'erase', 'explain', 'ours', 'theirs', 'preview', 'promote', 'ungated',
  'unchecked', 'verify',
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
