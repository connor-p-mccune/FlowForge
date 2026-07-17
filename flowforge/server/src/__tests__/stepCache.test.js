process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const {
  cachePolicy,
  cacheKey,
  stableStringify,
  lookup,
  store,
  clearWorkflow,
  pruneExpired,
  DEFAULT_TTL_SECONDS,
} = require('../services/stepCache')

// The cache table has a workflow FK, so entries need a real workflow row.
function seedWorkflow() {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', '{"nodes":[],"edges":[]}', userId, now, now)
  return wfId
}

function cacheRow(key) {
  return db.prepare('SELECT * FROM step_cache WHERE cache_key = ?').get(key)
}

describe('stableStringify', () => {
  it('is insensitive to object key order at every level', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 3 }], c: 'v' } }
    const b = { a: { c: 'v', d: [1, { x: 3, y: 2 }] }, b: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('distinguishes values that JSON.stringify would too', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }))
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })
})

describe('cacheKey', () => {
  it('produces the same key for the same work regardless of property order', () => {
    const k1 = cacheKey('wf', 'transform', { template: '{}', extra: 1 }, { in: true })
    const k2 = cacheKey('wf', 'transform', { extra: 1, template: '{}' }, { in: true })
    expect(k1).toBe(k2)
    expect(k1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the config, input, type, or workflow changes', () => {
    const base = cacheKey('wf', 'transform', { template: '{}' }, { in: 1 })
    expect(cacheKey('wf', 'transform', { template: '{"a":1}' }, { in: 1 })).not.toBe(base)
    expect(cacheKey('wf', 'transform', { template: '{}' }, { in: 2 })).not.toBe(base)
    expect(cacheKey('wf', 'map', { template: '{}' }, { in: 1 })).not.toBe(base)
    expect(cacheKey('wf2', 'transform', { template: '{}' }, { in: 1 })).not.toBe(base)
  })

  it('ignores the cache block itself, so tuning the TTL keeps entries valid', () => {
    const k1 = cacheKey('wf', 'transform', { template: '{}', cache: { enabled: true, ttlSeconds: 60 } }, {})
    const k2 = cacheKey('wf', 'transform', { template: '{}', cache: { enabled: true, ttlSeconds: 999 } }, {})
    expect(k1).toBe(k2)
  })
})

describe('cachePolicy', () => {
  const nodeOf = (type, config) => ({ id: 'n1', type, data: { config } })

  it('returns a policy only for cacheable types with cache.enabled === true', () => {
    expect(cachePolicy(nodeOf('transform', { cache: { enabled: true } }))).toEqual({
      ttlSeconds: DEFAULT_TTL_SECONDS,
    })
    expect(cachePolicy(nodeOf('transform', { cache: { enabled: false } }))).toBeNull()
    expect(cachePolicy(nodeOf('transform', {}))).toBeNull()
    // Side-effect and control-flow nodes never cache, whatever their config says.
    expect(cachePolicy(nodeOf('action-email', { cache: { enabled: true } }))).toBeNull()
    expect(cachePolicy(nodeOf('condition', { cache: { enabled: true } }))).toBeNull()
    expect(cachePolicy(nodeOf('sub-workflow', { cache: { enabled: true } }))).toBeNull()
  })

  it('clamps the TTL and falls back to the default on nonsense', () => {
    expect(cachePolicy(nodeOf('transform', { cache: { enabled: true, ttlSeconds: 60 } })).ttlSeconds).toBe(60)
    expect(cachePolicy(nodeOf('transform', { cache: { enabled: true, ttlSeconds: -5 } })).ttlSeconds).toBe(DEFAULT_TTL_SECONDS)
    expect(cachePolicy(nodeOf('transform', { cache: { enabled: true, ttlSeconds: 'soon' } })).ttlSeconds).toBe(DEFAULT_TTL_SECONDS)
    expect(
      cachePolicy(nodeOf('transform', { cache: { enabled: true, ttlSeconds: 10 ** 9 } })).ttlSeconds
    ).toBe(24 * 60 * 60)
  })
})

describe('store / lookup', () => {
  it('round-trips an entry and counts hits', () => {
    const wfId = seedWorkflow()
    const key = cacheKey(wfId, 'transform', { template: '{}' }, {})
    expect(lookup(key)).toBeNull()

    expect(store(key, { workflowId: wfId, nodeId: 'n1', outputJson: '{"a":1}', ttlSeconds: 60 })).toBe(true)
    expect(lookup(key)).toEqual({ outputJson: '{"a":1}' })
    expect(lookup(key)).toEqual({ outputJson: '{"a":1}' })
    expect(cacheRow(key).hits).toBe(2)
  })

  it('treats an expired row as a miss and deletes it', () => {
    const wfId = seedWorkflow()
    const key = cacheKey(wfId, 'transform', { template: 'x' }, {})
    store(key, { workflowId: wfId, nodeId: 'n1', outputJson: '{}', ttlSeconds: 60 })
    db.prepare('UPDATE step_cache SET expires_at = ? WHERE cache_key = ?')
      .run(new Date(Date.now() - 1000).toISOString(), key)

    expect(lookup(key)).toBeNull()
    expect(cacheRow(key)).toBeUndefined()
  })

  it('refuses outputs over the size cap without failing', () => {
    const wfId = seedWorkflow()
    const key = cacheKey(wfId, 'transform', { template: 'big' }, {})
    const huge = JSON.stringify({ blob: 'x'.repeat(300 * 1024) })
    expect(store(key, { workflowId: wfId, nodeId: 'n1', outputJson: huge, ttlSeconds: 60 })).toBe(false)
    expect(lookup(key)).toBeNull()
  })

  it('replaces an existing entry for the same key', () => {
    const wfId = seedWorkflow()
    const key = cacheKey(wfId, 'transform', { template: 'r' }, {})
    store(key, { workflowId: wfId, nodeId: 'n1', outputJson: '{"v":1}', ttlSeconds: 60 })
    store(key, { workflowId: wfId, nodeId: 'n1', outputJson: '{"v":2}', ttlSeconds: 60 })
    expect(lookup(key)).toEqual({ outputJson: '{"v":2}' })
  })
})

describe('clearWorkflow / pruneExpired', () => {
  it('clears only the given workflow and reports the count', () => {
    const wfA = seedWorkflow()
    const wfB = seedWorkflow()
    store(cacheKey(wfA, 't', { a: 1 }, {}), { workflowId: wfA, nodeId: 'n', outputJson: '{}', ttlSeconds: 60 })
    store(cacheKey(wfA, 't', { a: 2 }, {}), { workflowId: wfA, nodeId: 'n', outputJson: '{}', ttlSeconds: 60 })
    store(cacheKey(wfB, 't', { a: 1 }, {}), { workflowId: wfB, nodeId: 'n', outputJson: '{}', ttlSeconds: 60 })

    expect(clearWorkflow(wfA)).toBe(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM step_cache WHERE workflow_id = ?').get(wfB).n).toBe(1)
  })

  it('prunes only expired rows', () => {
    const wfId = seedWorkflow()
    const live = cacheKey(wfId, 't', { keep: true }, {})
    const dead = cacheKey(wfId, 't', { keep: false }, {})
    store(live, { workflowId: wfId, nodeId: 'n', outputJson: '{}', ttlSeconds: 600 })
    store(dead, { workflowId: wfId, nodeId: 'n', outputJson: '{}', ttlSeconds: 600 })
    db.prepare('UPDATE step_cache SET expires_at = ? WHERE cache_key = ?')
      .run(new Date(Date.now() - 1000).toISOString(), dead)

    expect(pruneExpired()).toBe(1)
    expect(cacheRow(live)).toBeDefined()
    expect(cacheRow(dead)).toBeUndefined()
  })

  it('cache rows cascade away with their workflow', () => {
    const wfId = seedWorkflow()
    store(cacheKey(wfId, 't', {}, {}), { workflowId: wfId, nodeId: 'n', outputJson: '{}', ttlSeconds: 60 })
    db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM step_cache WHERE workflow_id = ?').get(wfId).n).toBe(0)
  })
})
