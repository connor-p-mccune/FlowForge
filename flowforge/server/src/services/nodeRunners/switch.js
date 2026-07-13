// Switch node: multi-way routing. Where a condition node splits a run two ways
// (true/false), a switch evaluates an ordered list of labelled FXL cases and
// routes the run down the *first* one that matches — or a `default` branch when
// none do. It's the difference between an `if` and a `switch` statement.
//
//   config.cases   [{ label, expression }, …] — evaluated top to bottom. `label`
//                  is both the branch's name and its edge handle; `expression`
//                  is an FXL boolean over the node's merged input (fields in
//                  scope directly, plus `input` as the whole upstream bag, just
//                  like the condition node's expression mode).
//
// Output: { result, matched, matchedLabel, matchedIndex }. `result` is the
// matched label (or 'default'), which the engine compares against each outgoing
// edge's sourceHandle to activate exactly one branch — the *same* mechanism the
// condition and approval nodes route through, so the engine needed no new
// branching concept, only 'switch' added to its set of branching types.
//
// The cases are pure boolean tests with no side effects, so — like the condition
// and filter nodes — a switch runs for real even in dry-run mode; routing a test
// run down the branch it would really take is the whole point of testing it.

const { compile } = require('../expression')

// The branch taken when no case matches. Kept as a named constant so the runner,
// the linter, and the canvas all agree on the default handle's id.
const DEFAULT_LABEL = 'default'

module.exports = async function runSwitch(config, input = {}) {
  const cases = Array.isArray(config?.cases) ? config.cases : []
  if (cases.length === 0) {
    throw new Error('Switch node requires at least one case')
  }

  // Fields flow in directly; `input` aliases the whole merged upstream object —
  // so both `status == "open"` and `input.status == "open"` work.
  const scope = { ...input, input }

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i] || {}
    const label = typeof c.label === 'string' && c.label.trim() !== '' ? c.label.trim() : null
    const expression = c.expression
    if (!label) {
      throw new Error(`Switch case ${i + 1} has no label`)
    }
    if (expression == null || String(expression).trim() === '') {
      throw new Error(`Switch case "${label}" has no expression`)
    }

    let program
    try {
      program = compile(String(expression))
    } catch (err) {
      throw new Error(`Switch case "${label}" is invalid: ${err.message}`)
    }

    let verdict
    try {
      verdict = program.evaluateBoolean(scope)
    } catch (err) {
      throw new Error(`Switch case "${label}" failed: ${err.message}`)
    }
    if (verdict) {
      return { result: label, matched: true, matchedLabel: label, matchedIndex: i }
    }
  }

  // No case matched — take the default branch.
  return { result: DEFAULT_LABEL, matched: false, matchedLabel: DEFAULT_LABEL, matchedIndex: -1 }
}

module.exports.DEFAULT_LABEL = DEFAULT_LABEL
