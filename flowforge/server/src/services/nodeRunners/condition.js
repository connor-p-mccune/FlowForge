function looseEquals(a, b) {
  return String(a ?? '') === String(b ?? '')
}

module.exports = async function runCondition(config) {
  const { left, operator = 'equals', right } = config
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
