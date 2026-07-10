// Tiny argv parser — the CLI's whole surface is positionals plus a handful of
// --flags, so a dependency would be all cost. Supports `--flag value`,
// `--flag=value`, and boolean flags (a --flag followed by another flag, or by
// nothing, is `true`).

const BOOLEAN_FLAGS = new Set(['watch', 'help', 'version', 'json'])

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
      flags[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(body) || next === undefined || next.startsWith('--')) {
      flags[body] = true
    } else {
      flags[body] = next
      i++
    }
  }
  return { positionals, flags }
}

module.exports = { parseArgs }
