// Aggregate node: reduce a list to summary statistics — the third of the
// list-processing trio (Filter keeps items, Map reshapes them, Aggregate rolls
// them up).
//
//   source   a template resolving to an array (or JSON, or the array input).
//   value    an FXL expression evaluated per item to the number being summed
//            (e.g. `price * qty`). Optional — with no value, only `count` is
//            produced.
//   groupBy  an FXL expression evaluated per item to a group key (e.g.
//            `item.region`). Optional — with no groupBy the whole list is one
//            group.
//
// Output without groupBy: { count, sum, avg, min, max }. With groupBy:
// { count, groups: [{ key, count, sum, avg, min, max }] } in first-seen order.
// (sum/avg/min/max are omitted when no value expression is given.)
//
// Both expressions compile once and run per item, over the same per-item scope
// as Filter/Map (item fields, plus item / index / items). No side effects, so
// it runs for real in dry-run; bounded by the step limit and AGGREGATE_MAX_ITEMS.

const { compile } = require('../expression')

function maxItems() {
  const n = parseInt(process.env.AGGREGATE_MAX_ITEMS || '100000', 10)
  return Number.isFinite(n) && n > 0 ? n : 100000
}

function resolveItems(source, input) {
  let items = source
  if (typeof items === 'string' && items.trim() !== '') {
    try {
      items = JSON.parse(items)
    } catch {
      throw new Error('Aggregate source must be an array (or a template resolving to one)')
    }
  }
  if (items == null || items === '') {
    if (Array.isArray(input)) return input
    throw new Error('Aggregate node requires a source array')
  }
  if (!Array.isArray(items)) {
    throw new Error('Aggregate source must be an array (or a template resolving to one)')
  }
  return items
}

function compileOptional(source, label) {
  if (source == null || String(source).trim() === '') return null
  try {
    return compile(String(source))
  } catch (err) {
    throw new Error(`Aggregate ${label} is invalid: ${err.message}`)
  }
}

// Fold one numeric value into a running accumulator (or seed a new one).
function fold(acc, n) {
  if (!acc) return { count: 1, sum: n, min: n, max: n }
  acc.count += 1
  acc.sum += n
  if (n < acc.min) acc.min = n
  if (n > acc.max) acc.max = n
  return acc
}

// Shape an accumulator into the output stats, dropping the numeric fields when
// no value expression was supplied (count-only aggregation).
function finalize(acc, hasValue) {
  if (!hasValue) return { count: acc ? acc.count : 0 }
  if (!acc || acc.count === 0) return { count: 0, sum: 0, avg: 0, min: null, max: null }
  return { count: acc.count, sum: acc.sum, avg: acc.sum / acc.count, min: acc.min, max: acc.max }
}

module.exports = async function runAggregate(config, input = {}) {
  const items = resolveItems(config?.source, input)
  const cap = maxItems()
  if (items.length > cap) {
    throw new Error(`Aggregate is capped at ${cap} items per run (got ${items.length})`)
  }

  const valueProgram = compileOptional(config?.value, 'value expression')
  const groupProgram = compileOptional(config?.groupBy, 'group-by expression')
  const hasValue = Boolean(valueProgram)

  const scopeFor = (item, index) => {
    const fields = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    return { ...fields, item, index, items }
  }

  // Ungrouped: a single running accumulator.
  if (!groupProgram) {
    if (!hasValue) return { count: items.length }
    let acc = null
    items.forEach((item, index) => {
      acc = fold(acc, numericValue(valueProgram, scopeFor(item, index), index, items.length))
    })
    return finalize(acc, hasValue)
  }

  // Grouped: an accumulator per key, kept in first-seen order.
  const order = []
  const accByKey = new Map()
  const keyByString = new Map()
  items.forEach((item, index) => {
    const scope = scopeFor(item, index)
    const rawKey = groupProgram.evaluate(scope)
    const keyStr = typeof rawKey === 'object' ? JSON.stringify(rawKey) : String(rawKey)
    if (!accByKey.has(keyStr)) {
      order.push(keyStr)
      keyByString.set(keyStr, rawKey)
      accByKey.set(keyStr, null)
    }
    const n = hasValue ? numericValue(valueProgram, scope, index, items.length) : 0
    accByKey.set(keyStr, fold(accByKey.get(keyStr), n))
  })

  const groups = order.map((keyStr) => ({
    key: keyByString.get(keyStr),
    ...finalize(accByKey.get(keyStr), hasValue),
  }))
  return { count: items.length, groups }
}

// Evaluate the value expression and coerce to a finite number, failing loudly on
// anything else (a non-numeric value in a sum is a mistake, not a silent NaN).
function numericValue(program, scope, index, total) {
  let raw
  try {
    raw = program.evaluate(scope)
  } catch (err) {
    throw new Error(`Aggregate value failed on item ${index + 1}/${total}: ${err.message}`)
  }
  // Number() also folds booleans (true → 1) so `sum` can count flags.
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`Aggregate value on item ${index + 1}/${total} is not a number`)
  }
  return n
}
