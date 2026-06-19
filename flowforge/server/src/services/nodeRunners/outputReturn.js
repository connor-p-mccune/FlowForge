// Output (return) node: marks what a workflow returns. It passes its merged input
// straight through as its output, so the engine's "final output" (see
// executionEngine.runExecution) is whatever flowed into this node. That matters
// for sub-workflows: when this workflow is called by a sub-workflow node, this
// node's output becomes the sub-workflow node's output in the parent. Shape the
// returned data with a transform node upstream if you need more than a pass-through.
module.exports = async function runOutputReturn(config, input) {
  return { ...input }
}
