const test = require('node:test')
const assert = require('node:assert/strict')
const { parseArgs } = require('../src/args')

test('separates positionals from flags', () => {
  const { positionals, flags } = parseArgs(['trigger', 'wf-1', '--data', '{"a":1}', '--watch'])
  assert.deepEqual(positionals, ['trigger', 'wf-1'])
  assert.deepEqual(flags, { data: '{"a":1}', watch: true })
})

test('supports --flag=value', () => {
  const { flags } = parseArgs(['--limit=5', '--key=deploy-1'])
  assert.deepEqual(flags, { limit: '5', key: 'deploy-1' })
})

test('a flag followed by another flag is boolean', () => {
  const { flags } = parseArgs(['--watch', '--limit', '10'])
  assert.deepEqual(flags, { watch: true, limit: '10' })
})

test('a known boolean flag never swallows the next positional', () => {
  const { positionals, flags } = parseArgs(['run', '--watch', 'exec-1'])
  assert.deepEqual(positionals, ['run', 'exec-1'])
  assert.equal(flags.watch, true)
})

test('a trailing value flag is boolean', () => {
  const { flags } = parseArgs(['--interval'])
  assert.equal(flags.interval, true)
})

test('collects a repeatable flag instead of keeping the last value', () => {
  // A repeated --break silently discarding all but the last would set a
  // breakpoint the caller never asked for and skip the ones they did.
  const { flags } = parseArgs(['debug', 'wf-1', '--break', 'h1', '--break', 'o1'])
  assert.deepEqual(flags.break, ['h1', 'o1'])
})

test('a repeatable flag given once is still an array', () => {
  assert.deepEqual(parseArgs(['--break', 'h1']).flags.break, ['h1'])
  assert.deepEqual(parseArgs(['--break=h1']).flags.break, ['h1'])
})

test('a non-repeatable flag keeps last-wins', () => {
  assert.equal(parseArgs(['--limit', '5', '--limit', '9']).flags.limit, '9')
})

test('treats --step and --stop as booleans even before a positional', () => {
  const { positionals, flags } = parseArgs(['debug', '--step', 'wf-1'])
  assert.equal(flags.step, true)
  assert.deepEqual(positionals, ['debug', 'wf-1'])
})

// Every flag no code path reads a value from. Written out one per line rather
// than looped over the set itself, because a test that reads the same list the
// parser does would pass no matter what is in it.
test('a value-less flag never eats the argument after it', () => {
  const cases = [
    ['effects', '--deep', 'wf-1'],
    ['effects', '--ungated', 'wf-1'],
    ['exposure', '--unchecked', 'ws-1'],
    ['backfill', '--all', 'wf-1'],
    ['subject', '--erase', 'a@b.com'],
    ['query', '--explain', 'wf-1'],
    ['merge', '--ours', 'wf-1'],
    ['merge', '--theirs', 'wf-1'],
    ['backfill', '--preview', 'wf-1'],
    ['release', '--promote', 'wf-1'],
    ['audit', '--verify', 'ws-1'],
  ]
  for (const argv of cases) {
    const { positionals, flags } = parseArgs(argv)
    assert.deepEqual(positionals, [argv[0], argv[2]], argv.join(' '))
    assert.equal(flags[argv[1].slice(2)], true, argv.join(' '))
  }
})

test('leaves a flag that takes an optional value alone', () => {
  // --rollback and --recent are read as strings when given one, so the parser
  // must not decide for them.
  assert.equal(parseArgs(['release', 'wf-1', '--rollback', 'bad p99']).flags.rollback, 'bad p99')
  assert.equal(parseArgs(['release', 'wf-1', '--rollback']).flags.rollback, true)
  assert.equal(parseArgs(['drift', 'wf-1', '--recent', '20']).flags.recent, '20')
})
