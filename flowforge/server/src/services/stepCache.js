// Step-level result cache: content-addressed memoisation for expensive,
// re-runnable nodes. A node that opts in (config.cache.enabled) gets its
// output stored under a key derived from *what would actually run* — the
// node's type, its fully resolved config (templates and secrets substituted),
// and its merged input — so a later run whose node would do byte-for-byte the
// same work adopts the recorded output instead of doing it again. Any change
// to the config, an upstream output, or a referenced secret produces a
// different key, which is the whole invalidation story: nothing to flush,
// nothing to get stale silently.
//
// Scope and safety:
// - Entries are scoped per workflow (the key includes the workflow id, and
//   the row carries an ON DELETE CASCADE FK), so identical nodes in different
//   workflows — possibly different workspaces — can never share a result.
// - Only re-runnable node types are cacheable (CACHEABLE_TYPES). Branching
//   and waiting nodes route control flow, and pure outputs are cheaper to run
//   than to look up; the engine ignores cache config on anything else and the
//   linter says so.
// - The stored output is the *redacted* serialisation — the engine passes the
//   same string it persists on the step row — so a secret echoed back by an
//   API never lands in the cache table (mirroring how resume's 'reused' steps
//   work).
// - TTL is bounded ([1s, 24h], default 300s) and expiry is lazy: a lookup
//   that finds an expired row treats it as a miss and deletes it; the
//   retention sweep prunes the rest in bulk.

const crypto = require('crypto')
const db = require('../config/database')

// Node types whose output may be cached. Everything here is a pure
// input→output computation or an idempotent-by-declaration call: the author
// turning caching on for an HTTP node is saying "repeats of this exact
// request may reuse the response" (the linter warns when that request isn't a
// GET). Deliberately excluded: side-effect actions (email/Slack — a cache hit
// would silently not send), branching/waiting nodes (they route, not
// compute), sub-workflow/for-each (they spawn real child runs), and outputs
// (cheaper to run than to look up).
const CACHEABLE_TYPES = new Set([
  'action-http',
  'transform',
  'filter',
  'map',
  'aggregate',
  'ai-prompt',
  'ai-classify',
  'ai-extract',
])

const DEFAULT_TTL_SECONDS = 300
const MAX_TTL_SECONDS = 24 * 60 * 60

// Outputs above this size aren't cached — a multi-megabyte API response would
// bloat SQLite for a lookup that saves less than it costs.
function maxOutputBytes() {
  const n = parseInt(process.env.STEP_CACHE_MAX_BYTES || '262144', 10)
  return Number.isFinite(n) && n > 0 ? n : 262144
}

// A node's cache policy, or null when the node doesn't cache. Read from the
// *raw* config (like the on-error policy): whether a node caches is a static
// authoring decision, so upstream data must not be able to toggle it.
function cachePolicy(node) {
  if (!CACHEABLE_TYPES.has(node.type)) return null
  const cache = node.data?.config?.cache
  if (!cache || typeof cache !== 'object' || cache.enabled !== true) return null
  return { ttlSeconds: normalizeTtl(cache.ttlSeconds) }
}

function normalizeTtl(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS
  return Math.min(Math.ceil(n), MAX_TTL_SECONDS)
}

// Deterministic serialisation: JSON.stringify with object keys sorted at
// every level, so two configs that differ only in property order hash the
// same. Handles the JSON-ish values the engine deals in; anything exotic
// (undefined, functions) serialises as JSON.stringify would.
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    const parts = keys
      .map((k) => (value[k] === undefined ? null : `${JSON.stringify(k)}:${stableStringify(value[k])}`))
      .filter(Boolean)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// The content address. config is the node's *resolved* config — after
// template and secret substitution — minus the cache block itself, so tuning
// the TTL doesn't invalidate existing entries. Including resolved secrets is
// deliberate (and safe — the key is a one-way hash): rotating a secret
// changes the key, so a cached response fetched with the old credential is
// never served against the new one.
function cacheKey(workflowId, nodeType, config, input) {
  const { cache: _cache, ...rest } = config || {}
  const material = stableStringify({ workflowId, nodeType, config: rest, input: input ?? {} })
  return crypto.createHash('sha256').update(material).digest('hex')
}

// Cache read. Returns { outputJson } on a live hit, null on a miss. An
// expired row is a miss that also deletes itself — lazy expiry keeps reads
// self-cleaning without a timer.
function lookup(key) {
  const row = db.prepare(
    'SELECT output_json, expires_at FROM step_cache WHERE cache_key = ?'
  ).get(key)
  if (!row) return null
  if (row.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM step_cache WHERE cache_key = ?').run(key)
    return null
  }
  db.prepare('UPDATE step_cache SET hits = hits + 1 WHERE cache_key = ?').run(key)
  return { outputJson: row.output_json }
}

// Cache write. outputJson is the redacted serialisation the engine already
// produced for the step row. Returns true when stored; false when the output
// was over the size cap (the run itself is unaffected — it just isn't
// memoised). INSERT OR REPLACE so a concurrent identical run can't conflict.
function store(key, { workflowId, nodeId, outputJson, ttlSeconds }) {
  if (typeof outputJson !== 'string' || Buffer.byteLength(outputJson) > maxOutputBytes()) {
    return false
  }
  const now = new Date()
  const expires = new Date(now.getTime() + normalizeTtl(ttlSeconds) * 1000)
  db.prepare(
    `INSERT OR REPLACE INTO step_cache
       (cache_key, workflow_id, node_id, output_json, hits, created_at, expires_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(key, workflowId, nodeId, outputJson, now.toISOString(), expires.toISOString())
  return true
}

// Drop every entry for a workflow — the manual override for "I know the
// upstream data changed even though the request looks the same". Returns the
// number of rows cleared.
function clearWorkflow(workflowId) {
  return db.prepare('DELETE FROM step_cache WHERE workflow_id = ?').run(workflowId).changes
}

// Bulk-prune expired rows (bounded, for the retention sweep).
function pruneExpired(limit = 5000) {
  return db.prepare(
    `DELETE FROM step_cache WHERE cache_key IN (
       SELECT cache_key FROM step_cache WHERE expires_at <= ? LIMIT ?
     )`
  ).run(new Date().toISOString(), limit).changes
}

module.exports = {
  CACHEABLE_TYPES,
  DEFAULT_TTL_SECONDS,
  cachePolicy,
  cacheKey,
  stableStringify,
  lookup,
  store,
  clearWorkflow,
  pruneExpired,
}
