// Condition node: evaluates to { result: true|false }, which the engine uses to
// activate the matching true/false branch. Two modes:
//
//   • the simple left/operator/right comparison (the original, still the
//     default) — good for a single field check wired up from dropdowns; and
//   • an `expression` operator that evaluates a full FXL boolean expression
//     against the node's merged input, for rules a single comparison can't
//     express: `amount > 1000 && status in ["pending", "review"]`.
//
// In expression mode the input's fields are in scope directly (`amount`,
// `status`), with `input` as an alias for the whole upstream bag — so both
// `amount > 1000` and `input.amount > 1000` work. Unlike the other config
// fields, the expression is *not* a {{...}} template: it reads live values from
// the scope itself, which is what lets it compute rather than just substitute.

const { evaluateBoolean } = require('../expression')

function looseEquals(a, b) {
  return String(a ?? '') === String(b ?? '')
}

module.exports = async function runCondition(config, input = {}) {
  const { operator = 'equals' } = config

  if (operator === 'expression') {
    const source = config.expression
    if (source == null || String(source).trim() === '') {
      throw new Error('Condition node: an expression is required')
    }
    // Fields flow in directly; `input` aliases the whole merged upstream object.
    const scope = { ...input, input }
    return { result: evaluateBoolean(String(source), scope) }
  }

  const { left, right } = config
  let result
  switch (operator) {
    case 'equals':
      result = looseEquals(left, right)
      break
    case 'not_equals':
      result = !looseEquals(left, right)
      break
    case 'contains':
      result = String(left ?? '').includes(String(right ?? ''))
      break
    case 'greater_than':
      result = Number(left) > Number(right)
      break
    case 'less_than':
      result = Number(left) < Number(right)
      break
    default:
      throw new Error(`Condition node: unknown operator "${operator}"`)
  }
  return { result }
}
