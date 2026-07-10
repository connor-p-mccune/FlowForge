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
