// The help text against the command registry.
//
// The tests beside this one pin what each command *does*. This one asks a
// question none of them can: is the command reachable by somebody who does not
// already know it exists? The drift only ever goes one way — a command gets
// added to serve a feature, and the help line is the step that gets forgotten.
//
// It matters more here than it would in most CLIs. `flowforge --help` is the
// entire discovery surface: there are no subcommand groups, no man page, and no
// shell completion, so a command missing from that block is a command nobody
// finds. The server has the same guardrail pointed at its OpenAPI spec
// (server/src/__tests__/openapi.test.js) for the same reason.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Read as source rather than required: bin/flowforge.js runs main() on load,
// so importing it would execute the CLI.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bin', 'flowforge.js'), 'utf8')

const matchAll = (pattern) => [...SOURCE.matchAll(pattern)].map((m) => m[1])

// `  name: require('../src/commands/name'),` — and the `.approve` / `.reject`
// form, where two commands share one module.
const registered = new Set(matchAll(/^ {2}([a-z][a-z-]*): require\(/gm))

// `  flowforge <name> …` in the usage block. The lookahead is load-bearing:
// without it a usage line for `exposureXX` would still contribute `exposure`,
// and a renamed command would keep passing on the strength of its own prefix.
const documented = new Set(matchAll(/^ {2}flowforge ([a-z][a-z-]*)(?=\s|$)/gm))

test('the registry and the usage block are both found', () => {
  // Everything below compares two sets. A regex that stopped matching would
  // make each comparison trivially true, so the sets are sized first.
  assert.ok(registered.size > 30, `found ${registered.size} registered commands`)
  assert.ok(documented.size > 30, `found ${documented.size} documented commands`)
})

test('every command is in the help text', () => {
  // `flowforge --help` is the whole discovery surface: no groups, no man page,
  // no completion. A command missing from it is a command nobody finds.
  const undocumented = [...registered].filter((c) => !documented.has(c)).sort()
  assert.deepEqual(undocumented, [])
})

test('the help text does not advertise a command that is gone', () => {
  // The other direction, and the one that costs trust rather than reach: a
  // usage line for a renamed command sends somebody to "Unknown command".
  const stale = [...documented].filter((c) => !registered.has(c)).sort()
  assert.deepEqual(stale, [])
})

test('every registered command resolves to a function', () => {
  // A typo in a require path throws at load and would be caught by any command
  // running at all. A typo in a `.approve` suffix does not: it leaves an entry
  // that dispatches to undefined and fails only when somebody types that one
  // word.
  const registry = SOURCE.slice(SOURCE.indexOf('const COMMANDS'), SOURCE.indexOf('const OFFLINE'))
  let seen = 0
  for (const [, name, modulePath, prop] of registry.matchAll(
    /^ {2}([a-z][a-z-]*): require\('([^']+)'\)(?:\.([a-z]+))?,/gm
  )) {
    const loaded = require(modulePath)
    const handler = prop ? loaded[prop] : loaded
    assert.equal(typeof handler, 'function', `${name} -> ${modulePath}${prop ? `.${prop}` : ''}`)
    seen += 1
  }
  assert.equal(seen, registered.size)
})
