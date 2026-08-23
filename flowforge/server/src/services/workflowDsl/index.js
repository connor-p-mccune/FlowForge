// The `.flow` text format: the reviewable half of workflows-as-code.
//
// `parse.js` has the motivation and the grammar; `format.js` has the emit
// order and why it is the signature's canonical order. This is the seam the
// rest of the codebase imports.

const { parseWorkflow, DslError, GUARANTEE_KINDS } = require('./parse')
const { formatWorkflow } = require('./format')

module.exports = { parseWorkflow, formatWorkflow, DslError, GUARANTEE_KINDS }
