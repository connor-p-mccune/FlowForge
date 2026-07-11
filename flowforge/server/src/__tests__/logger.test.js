// The structured logger: line shape, level filtering, child loggers, and the
// never-throw serialization guarantees.

process.env.NODE_ENV = 'test'

const logger = require('../services/logger')

describe('logger', () => {
  let lines
  let restoreSink
  const originalLevel = process.env.LOG_LEVEL

  beforeEach(() => {
    lines = []
    restoreSink = logger._setSink((line) => lines.push(line))
    process.env.LOG_LEVEL = 'debug'
    delete process.env.LOG_FORMAT
  })

  afterEach(() => {
    logger._setSink(restoreSink)
    if (originalLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = originalLevel
    delete process.env.LOG_FORMAT
  })

  it('emits one JSON line with level, time, msg, and fields', () => {
    logger.info('hello', { a: 1, b: 'two' })
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0])
    expect(entry).toMatchObject({ level: 'info', msg: 'hello', a: 1, b: 'two' })
    expect(new Date(entry.time).getTime()).not.toBeNaN()
  })

  it('filters below the active level, read per call', () => {
    process.env.LOG_LEVEL = 'warn'
    logger.debug('nope')
    logger.info('nope')
    logger.warn('yes')
    logger.error('also yes')
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error'])
  })

  it('defaults to silent under NODE_ENV=test unless LOG_LEVEL is set', () => {
    delete process.env.LOG_LEVEL
    logger.error('suppressed in tests')
    expect(lines).toHaveLength(0)
  })

  it('binds child fields onto every line, composing through nesting', () => {
    const child = logger.child({ requestId: 'r-1' }).child({ userId: 'u-9' })
    child.info('scoped', { extra: true })
    expect(JSON.parse(lines[0])).toMatchObject({
      requestId: 'r-1',
      userId: 'u-9',
      extra: true,
    })
  })

  it('flattens Error values and survives circular fields', () => {
    logger.error('boom', { error: new Error('kaput') })
    expect(JSON.parse(lines[0]).error).toEqual({ message: 'kaput' })

    const loop = { name: 'a' }
    loop.self = loop
    logger.info('circular', { loop })
    expect(JSON.parse(lines[1]).loop).toEqual({ name: 'a', self: '[circular]' })
  })

  it('renders a human-readable line in pretty mode', () => {
    process.env.LOG_FORMAT = 'pretty'
    logger.warn('careful', { path: '/x', status: 500 })
    expect(lines[0]).toMatch(/WARN\s+careful path=\/x status=500/)
  })
})
