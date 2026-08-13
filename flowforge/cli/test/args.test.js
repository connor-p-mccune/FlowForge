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
