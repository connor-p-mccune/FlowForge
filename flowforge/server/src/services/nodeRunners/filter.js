// Filter node: keep the items of a list that satisfy an FXL predicate.
//
//   source     a template resolving to an array (e.g. {{http-1.body}}), or a
//              JSON array literal. Falls back to the node's input when that is
//              itself an array.
//   predicate  an FXL boolean expression evaluated once per item. Each item's
//              fields are in scope directly (so `price > 10` works on a list of
//              objects), with `item`, `index`, and `items` also available:
//                price > 10 && inStock
//                contains(lower(item.tags), "urgent")
//                index < 5
//
// Unlike a {{...}} template, the predicate reads live values from each item's
// scope — it computes, it doesn't substitute. Filtering has no side effects, so
// it runs for real in dry-run mode like the condition and transform nodes.
//
// The predicate is compiled once and evaluated per item, so a large list pays
// the parse cost a single time. A per-item scope and the evaluator's own step
// limit bound the work; FILTER_MAX_ITEMS caps the list length so a runaway
// upstream payload can't wedge the run.

const { compile } = require('../expression')

function maxItems() {
  const n = parseInt(process.env.FILTER_MAX_ITEMS || '10000', 10)
  return Number.isFinite(n) && n > 0 ? n : 10000
}

// Resolve the source config (already run through the engine's templating) to a
// real array: a live array reference, a JSON array string, or the node input
// when it is itself an array.
function resolveItems(source, input) {
  let items = source
  if (typeof items === 'string' && items.trim() !== '') {
    try {
      items = JSON.parse(items)
    } catch {
      throw new Error('Filter source must be an array (or a template resolving to one)')
    }
  }
  if (items == null || items === '') {
    if (Array.isArray(input)) return input
    throw new Error('Filter node requires a source array')
  }
  if (!Array.isArray(items)) {
    throw new Error('Filter source must be an array (or a template resolving to one)')
  }
  return items
}

module.exports = async function runFilter(config, input = {}) {
  const source = config?.source
  const predicate = config?.predicate
  if (predicate == null || String(predicate).trim() === '') {
    throw new Error('Filter node requires a predicate expression')
  }

  const items = resolveItems(source, input)
  const cap = maxItems()
  if (items.length > cap) {
    throw new Error(`Filter is capped at ${cap} items per run (got ${items.length})`)
  }

  // Compile once; a syntax error surfaces here as the node's failure.
  let program
  try {
    program = compile(String(predicate))
  } catch (err) {
    throw new Error(`Filter predicate is invalid: ${err.message}`)
  }

  const kept = []
  items.forEach((item, index) => {
    const fields = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    const scope = { ...fields, item, index, items }
    let verdict
    try {
      verdict = program.evaluateBoolean(scope)
    } catch (err) {
      throw new Error(`Filter predicate failed on item ${index + 1}/${items.length}: ${err.message}`)
    }
    if (verdict) kept.push(item)
  })

  return { items: kept, count: kept.length, total: items.length }
}
