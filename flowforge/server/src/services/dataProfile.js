// What a node's output *looks like*, and whether it has stopped looking like it.
//
// Every monitor in this codebase watches one of two things. Time: duration
// percentiles, the Mann-Kendall trend, Pettitt's change point, the critical
// path. Or outcome: success rate, the SLO error budget, the heartbeat, the
// canary's z-test. Nothing watches the **data**.
//
// So a workflow whose upstream API quietly starts returning `null` for
// `customer.email` in 40% of records is green on every dashboard FlowForge has.
// Every run completes. Every step succeeds. The durations are unchanged. The
// success rate is 100%. The graph is well-typed, the invariants hold, every
// branch is reachable, and forty percent of the emails are not being sent —
// which is a production incident that no existing check can express, because
// none of them ever looks at a value.
//
// This module is the missing half, in two pure pieces:
//
//   profileRecord(value)          one output → a per-path summary
//   mergeProfiles(a, b)           accumulate a window of them
//   compareProfiles(base, recent) two windows → findings
//
// No database, no engine. `driftMonitor.js` supplies the windows.
//
// ---------------------------------------------------------------------------
// Precision is the whole design, for the same reason it is in lineage.js: a
// drift report that fires on everything is one nobody reads, and the second
// false alarm is the one that trains somebody to close the tab. Five rules do
// the work, and each of them exists because the obvious implementation would
// have produced a finding that is technically true and worthless:
//
//   * Both windows must clear a sample floor, per path. A field that appeared
//     in six records is not evidence of anything.
//   * Every test needs an **effect size**, not just significance. Over five
//     hundred records a KS test will find a real, permanent, 2% shift in a
//     timestamp field, and reporting it is how the report gets ignored.
//   * A high-cardinality string is an **identifier, not a category**. Order ids
//     are 100% "new values" in every window; PSI over them is a number that is
//     always large and never means anything.
//   * A redacted value is **excluded**. Secrets are masked before persistence,
//     so a masked field's distribution is a constant — and a change to what is
//     redacted would otherwise read as a change in the data.
//   * What could **not** be compared is counted and returned. A drift report
//     that silently omits the fields it skipped is claiming a coverage it does
//     not have.
// ---------------------------------------------------------------------------

const {
  proportionShiftTest,
  kolmogorovSmirnov,
  populationStabilityIndex,
  MIN_KS_SAMPLE,
} = require('./statistics')

// The mask the engine substitutes for secret and declared-redacted values
// before anything is persisted (executionEngine.js REDACTED).
const REDACTION_MASK = '••••••'

// Structural bounds. A workflow can emit an arbitrarily large document and this
// runs on a read path, so every dimension is capped and the truncation is
// reported rather than hidden.
const LIMITS = {
  maxPaths: 240,
  maxDepth: 6,
  maxArrayElements: 25,
  maxCategories: 50,
  maxNumeric: 2000,
  maxStringLength: 200,
}

// A path is only compared when both windows have at least this many
// observations of it.
const MIN_PATH_SAMPLE = 25

// Effect floors. Significance alone is not a finding — see the header.
const MIN_RATE_DELTA = 0.1 // presence and null-rate shifts
const MIN_KS_EFFECT = 0.2 // largest CDF gap
const MAJOR_RATE_DELTA = 0.25
const MAJOR_KS_EFFECT = 0.35
// Above this share of distinct values, a string field is an identifier rather
// than a category, and comparing its "categories" is meaningless.
const IDENTIFIER_DISTINCT_RATIO = 0.8

const emptyStat = () => ({
  seen: 0,
  nulls: 0,
  masked: 0,
  types: {},
  numeric: [],
  categories: {},
  categoryOverflow: false,
  lengths: [],
})

function kindOf(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

// Walk one output value into per-path observations.
//
// Arrays are descended into as well as recorded: `orders` gets a length, and
// `orders[]` plus `orders[].amount` get the elements. That second part is what
// makes the common case work at all — a workflow fetching a list is one record
// per run at the top level and hundreds of records one level down, and the
// field that starts coming back null is almost always down there.
function profileRecord(value, limits = LIMITS) {
  const profile = { records: 1, paths: {}, truncated: false }

  const statFor = (path) => {
    if (!profile.paths[path]) {
      if (Object.keys(profile.paths).length >= limits.maxPaths) {
        profile.truncated = true
        return null
      }
      profile.paths[path] = emptyStat()
    }
    return profile.paths[path]
  }

  const visit = (path, node, depth) => {
    const stat = statFor(path)
    if (!stat) return
    stat.seen += 1
    const kind = kindOf(node)
    stat.types[kind] = (stat.types[kind] || 0) + 1

    if (kind === 'null') {
      stat.nulls += 1
      return
    }
    if (kind === 'number') {
      if (Number.isFinite(node) && stat.numeric.length < limits.maxNumeric) stat.numeric.push(node)
      return
    }
    if (kind === 'boolean') {
      stat.categories[String(node)] = (stat.categories[String(node)] || 0) + 1
      return
    }
    if (kind === 'string') {
      if (node === REDACTION_MASK || node.includes(REDACTION_MASK)) {
        stat.masked += 1
        return
      }
      if (stat.lengths.length < limits.maxNumeric) stat.lengths.push(node.length)
      // A long string is free text, not a label. Bucketing it would fill the
      // category map with one entry per record and prove only that people write
      // different sentences.
      if (node.length <= limits.maxStringLength) {
        if (stat.categories[node] !== undefined) {
          stat.categories[node] += 1
        } else if (Object.keys(stat.categories).length < limits.maxCategories) {
          stat.categories[node] = 1
        } else {
          stat.categoryOverflow = true
        }
      } else {
        stat.categoryOverflow = true
      }
      return
    }
    if (depth >= limits.maxDepth) return
    if (kind === 'array') {
      if (stat.lengths.length < limits.maxNumeric) stat.lengths.push(node.length)
      const take = Math.min(node.length, limits.maxArrayElements)
      if (take < node.length) profile.truncated = true
      for (let i = 0; i < take; i++) visit(`${path}[]`, node[i], depth + 1)
      return
    }
    // object
    for (const key of Object.keys(node)) {
      visit(path ? `${path}.${key}` : key, node[key], depth + 1)
    }
  }

  const rootKind = kindOf(value)
  if (rootKind === 'object') {
    for (const key of Object.keys(value)) visit(key, value[key], 1)
  } else if (rootKind === 'array') {
    const stat = statFor('')
    if (stat) {
      stat.seen += 1
      stat.types.array = (stat.types.array || 0) + 1
      stat.lengths.push(value.length)
    }
    const take = Math.min(value.length, limits.maxArrayElements)
    for (let i = 0; i < take; i++) visit('[]', value[i], 1)
  }
  return profile
}

// Even-stride downsample. Called when two merged samples exceed the cap: taking
// the first N would let the oldest runs in the window decide the distribution,
// which is exactly backwards for a check about change over time. A stride keeps
// coverage across the whole window and is deterministic, so the same window
// always produces the same verdict.
function downsample(values, limit) {
  if (values.length <= limit) return values
  const stride = values.length / limit
  const out = []
  for (let i = 0; out.length < limit; i += stride) out.push(values[Math.floor(i)])
  return out
}

function mergeStat(a, b, limits) {
  const merged = emptyStat()
  merged.seen = a.seen + b.seen
  merged.nulls = a.nulls + b.nulls
  merged.masked = a.masked + b.masked
  for (const source of [a.types, b.types]) {
    for (const [kind, count] of Object.entries(source)) {
      merged.types[kind] = (merged.types[kind] || 0) + count
    }
  }
  merged.numeric = downsample([...a.numeric, ...b.numeric], limits.maxNumeric)
  merged.lengths = downsample([...a.lengths, ...b.lengths], limits.maxNumeric)
  merged.categoryOverflow = a.categoryOverflow || b.categoryOverflow
  for (const source of [a.categories, b.categories]) {
    for (const [key, count] of Object.entries(source)) {
      if (merged.categories[key] !== undefined) {
        merged.categories[key] += count
      } else if (Object.keys(merged.categories).length < limits.maxCategories) {
        merged.categories[key] = count
      } else {
        merged.categoryOverflow = true
      }
    }
  }
  return merged
}

function mergeProfiles(a, b, limits = LIMITS) {
  if (!a) return b
  if (!b) return a
  const merged = {
    records: a.records + b.records,
    paths: {},
    truncated: Boolean(a.truncated || b.truncated),
  }
  const paths = new Set([...Object.keys(a.paths), ...Object.keys(b.paths)])
  for (const path of paths) {
    if (Object.keys(merged.paths).length >= limits.maxPaths) {
      merged.truncated = true
      break
    }
    merged.paths[path] = mergeStat(a.paths[path] || emptyStat(), b.paths[path] || emptyStat(), limits)
  }
  return merged
}

// The container a path lives in, for the presence denominator. `orders.total`
// is present-or-absent within the records that had an `orders`; a root key is
// present-or-absent within the records themselves.
//
// Returns null for an array-element path: `orders[]` is not a key that can be
// missing from `orders`, it *is* the elements, and a "presence rate" there
// would be the average array length wearing a percentage sign.
function parentOf(path) {
  if (path.endsWith('[]')) return null
  const cut = path.lastIndexOf('.')
  return cut === -1 ? '' : path.slice(0, cut)
}

function denominatorFor(profile, path) {
  const parent = parentOf(path)
  if (parent === null) return null
  if (parent === '') return profile.records
  return profile.paths[parent]?.seen ?? null
}

function dominantType(stat) {
  let best = null
  let bestCount = 0
  for (const [kind, count] of Object.entries(stat.types)) {
    if (kind === 'null') continue
    if (count > bestCount) {
      best = kind
      bestCount = count
    }
  }
  return best
}

const distinctRatio = (stat) => {
  const distinct = Object.keys(stat.categories).length
  const strings = stat.types.string || 0
  if (strings === 0) return 0
  return distinct / strings
}

// Is this field an identifier rather than a category? An order id is 100% new
// values in every window; PSI over it is always large and never means anything.
function looksLikeIdentifier(stat) {
  if (stat.categoryOverflow) return true
  const strings = stat.types.string || 0
  return strings >= MIN_PATH_SAMPLE && distinctRatio(stat) > IDENTIFIER_DISTINCT_RATIO
}

const pct = (v) => `${(v * 100).toFixed(1)}%`

// Compare two accumulated windows of the same node's output.
//
// `baseline` is the older window and `recent` the newer one; every finding is
// phrased as a change *from* baseline *to* recent.
function compareProfiles(baseline, recent, options = {}) {
  const minSample = Number.isFinite(options.minSample) ? options.minSample : MIN_PATH_SAMPLE
  const findings = []
  const skipped = []
  let compared = 0

  if (!baseline || !recent || baseline.records === 0 || recent.records === 0) {
    return { findings: [], compared: 0, skipped: [], paths: 0 }
  }

  const paths = [...new Set([...Object.keys(baseline.paths), ...Object.keys(recent.paths)])].sort()

  for (const path of paths) {
    const base = baseline.paths[path] || emptyStat()
    const now = recent.paths[path] || emptyStat()

    // A field the engine masked before persisting. Its "distribution" is the
    // redaction config, and a change to that would read as a change in the
    // data — which is the one thing this must never report.
    if (base.masked > base.seen / 2 || now.masked > now.seen / 2) {
      skipped.push({ path, reason: 'redacted' })
      continue
    }

    const baseDenom = denominatorFor(baseline, path)
    const nowDenom = denominatorFor(recent, path)

    // --- Presence: is the field still there? -------------------------------
    if (baseDenom != null && nowDenom != null && baseDenom >= minSample && nowDenom >= minSample) {
      const baseRate = base.seen / baseDenom
      const nowRate = now.seen / nowDenom
      const shift = proportionShiftTest(now.seen, nowDenom, base.seen, baseDenom)
      if (shift?.significant && Math.abs(nowRate - baseRate) >= MIN_RATE_DELTA) {
        const gone = nowRate === 0
        const arrived = baseRate === 0
        findings.push({
          path,
          kind: gone ? 'field-missing' : arrived ? 'field-added' : 'presence',
          severity: gone || arrived ? 'major' : Math.abs(nowRate - baseRate) >= MAJOR_RATE_DELTA ? 'major' : 'minor',
          summary: gone
            ? `${path} is no longer present (was in ${pct(baseRate)} of records)`
            : arrived
              ? `${path} is new (now in ${pct(nowRate)} of records)`
              : `${path} appears in ${pct(nowRate)} of records, was ${pct(baseRate)}`,
          detail: { baselineRate: baseRate, recentRate: nowRate, pValue: shift.pValue, test: 'two-proportion' },
        })
      }
    }

    if (base.seen < minSample || now.seen < minSample) {
      if (base.seen > 0 || now.seen > 0) skipped.push({ path, reason: 'too-few-samples' })
      continue
    }
    compared += 1

    // --- Null rate ---------------------------------------------------------
    const baseNullRate = base.nulls / base.seen
    const nowNullRate = now.nulls / now.seen
    const nullShift = proportionShiftTest(now.nulls, now.seen, base.nulls, base.seen)
    if (nullShift?.significant && Math.abs(nowNullRate - baseNullRate) >= MIN_RATE_DELTA) {
      findings.push({
        path,
        kind: 'null-rate',
        severity: Math.abs(nowNullRate - baseNullRate) >= MAJOR_RATE_DELTA ? 'major' : 'minor',
        summary: `${path} is null in ${pct(nowNullRate)} of records, was ${pct(baseNullRate)}`,
        detail: { baselineRate: baseNullRate, recentRate: nowNullRate, pValue: nullShift.pValue, test: 'two-proportion' },
      })
    }

    // --- Type --------------------------------------------------------------
    const baseType = dominantType(base)
    const nowType = dominantType(now)
    if (baseType && nowType && baseType !== nowType) {
      findings.push({
        path,
        kind: 'type-changed',
        severity: 'major',
        summary: `${path} is now ${nowType}, was ${baseType}`,
        detail: { baselineType: baseType, recentType: nowType, test: 'dominant-type' },
      })
    }

    // --- Numeric distribution ---------------------------------------------
    if (base.numeric.length >= MIN_KS_SAMPLE && now.numeric.length >= MIN_KS_SAMPLE) {
      const ks = kolmogorovSmirnov(now.numeric, base.numeric)
      if (ks?.significant && ks.d >= MIN_KS_EFFECT) {
        findings.push({
          path,
          kind: 'distribution',
          severity: ks.d >= MAJOR_KS_EFFECT ? 'major' : 'minor',
          summary: `${path}'s value distribution moved (D=${ks.d.toFixed(2)})`,
          detail: { d: ks.d, pValue: ks.pValue, n1: ks.n1, n2: ks.n2, test: 'kolmogorov-smirnov' },
        })
      } else if (!ks) {
        skipped.push({ path, reason: 'too-few-samples' })
      }
    }

    // --- Categorical distribution -----------------------------------------
    const baseCats = Object.keys(base.categories).length
    const nowCats = Object.keys(now.categories).length
    if (baseCats > 0 && nowCats > 0) {
      if (looksLikeIdentifier(base) || looksLikeIdentifier(now)) {
        skipped.push({ path, reason: 'identifier-like' })
      } else {
        const psi = populationStabilityIndex(base.categories, now.categories)
        if (psi && psi.severity !== 'none') {
          const moved = psi.contributions[0]
          findings.push({
            path,
            kind: 'categories',
            severity: psi.severity,
            summary:
              `${path}'s value mix shifted (PSI ${psi.psi.toFixed(2)})` +
              (moved ? ` — "${moved.key}" ${pct(moved.expected)} → ${pct(moved.actual)}` : ''),
            detail: { psi: psi.psi, contributions: psi.contributions, test: 'population-stability-index' },
          })
        }
      }
    }
  }

  // Most severe first, then by path so the order is stable between reads.
  const rank = (f) => (f.severity === 'major' ? 0 : 1)
  findings.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))

  return { findings, compared, skipped, paths: paths.length }
}

module.exports = {
  profileRecord,
  mergeProfiles,
  compareProfiles,
  downsample,
  parentOf,
  REDACTION_MASK,
  LIMITS,
  MIN_PATH_SAMPLE,
  MIN_RATE_DELTA,
  MIN_KS_EFFECT,
}
