// Map node: transform each item of a list with an FXL expression — the natural
// pair to the Filter node (filter keeps items, map reshapes them).
//
//   source   a template resolving to an array (e.g. {{http-1.body}}), or a JSON
//            array. Falls back to the node's input when that is itself an array.
//   mapping  an FXL expression evaluated once per item, usually an object
//            literal that builds the new shape:
//              { id: item.id, name: upper(item.name), total: price * qty }
//            but any expression works (`price * 1.2`, `item.email`).
//
// Each item's fields are in scope directly, with `item`, `index`, and `items`
// also available. Like Filter, the mapping is compiled once and evaluated per
// item, has no side effects (so it runs for real in dry-run), and is bounded by
// the evaluator's step limit plus MAP_MAX_ITEMS. Output is { items, count }.

const { compile } = require('../expression')

function maxItems() {
  const n = parseInt(process.env.MAP_MAX_ITEMS || '10000', 10)
  return Number.isFinite(n) && n > 0 ? n : 10000
}

// Resolve the (already-templated) source config to a real array.
function resolveItems(source, input) {
  let items = source
  if (typeof items === 'string' && items.trim() !== '') {
    try {
      items = JSON.parse(items)
    } catch {
      throw new Error('Map source must be an array (or a template resolving to one)')
    }
  }
  if (items == null || items === '') {
    if (Array.isArray(input)) return input
    throw new Error('Map node requires a source array')
  }
  if (!Array.isArray(items)) {
    throw new Error('Map source must be an array (or a template resolving to one)')
  }
  return items
}

module.exports = async function runMap(config, input = {}) {
  const source = config?.source
  const mapping = config?.mapping
  if (mapping == null || String(mapping).trim() === '') {
    throw new Error('Map node requires a mapping expression')
  }

  const items = resolveItems(source, input)
  const cap = maxItems()
  if (items.length > cap) {
    throw new Error(`Map is capped at ${cap} items per run (got ${items.length})`)
  }

  let program
  try {
    program = compile(String(mapping))
  } catch (err) {
    throw new Error(`Map expression is invalid: ${err.message}`)
  }

  const mapped = items.map((item, index) => {
    const fields = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    const scope = { ...fields, item, index, items }
    try {
      return program.evaluate(scope)
    } catch (err) {
      throw new Error(`Map expression failed on item ${index + 1}/${items.length}: ${err.message}`)
    }
  })

  return { items: mapped, count: mapped.length }
}
