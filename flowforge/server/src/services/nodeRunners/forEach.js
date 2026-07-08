// For-each node: fan a workflow out over a list. config.items resolves (via
// the engine's templating) to an array; the target workflow runs once per
// item, sequentially, receiving { item, index, total } as its trigger payload.
// Each iteration goes through the sub-workflow runner, so it inherits the same
// guarantees: cycle detection via the call stack, same-workspace boundary,
// deployed-only targets, and a child execution row linked to this node — the
// run detail view shows every iteration nested under the for-each step.
//
// Sequential on purpose: iterations often hit the same external API, and a
// workflow tool that silently fires N parallel calls is a footgun. The item
// cap (FOREACH_MAX_ITEMS, default 100) bounds runaway inputs.
//
// continueOnError: when set, a failed iteration records { index, error } and
// the loop keeps going; the node's output then reports succeeded/failed
// counts with results aligned to items (null where an iteration failed).
// Without it, the first failure fails the node (and the run).

const runSubWorkflow = require('./subWorkflow')

function maxItems() {
  const n = parseInt(process.env.FOREACH_MAX_ITEMS || '100', 10)
  return Number.isFinite(n) && n > 0 ? n : 100
}

module.exports = async function runForEach(config, input, isDryRun, ctx = {}) {
  const workflowId = config?.workflowId
  if (!workflowId) throw new Error('For-each node requires a target workflow')

  // items arrives either as a real array (config was exactly "{{node.field}}"
  // and the reference held an array) or as a string the user typed/templated —
  // accept JSON for the latter.
  let items = config?.items
  if (typeof items === 'string' && items.trim() !== '') {
    try {
      items = JSON.parse(items)
    } catch {
      throw new Error('For-each items must be an array (or a template resolving to one)')
    }
  }
  if (!Array.isArray(items)) {
    throw new Error('For-each items must be an array (or a template resolving to one)')
  }

  const cap = maxItems()
  if (items.length > cap) {
    throw new Error(`For-each is capped at ${cap} items per run (got ${items.length})`)
  }

  const total = items.length
  const results = new Array(total).fill(null)
  const errors = []

  for (let index = 0; index < total; index++) {
    try {
      results[index] = await runSubWorkflow(
        { workflowId },
        { item: items[index], index, total },
        isDryRun,
        ctx
      )
    } catch (err) {
      if (!config.continueOnError) {
        throw new Error(`For-each item ${index + 1}/${total} failed: ${err.message}`)
      }
      errors.push({ index, error: err.message })
    }
  }

  return {
    count: total,
    succeeded: total - errors.length,
    failed: errors.length,
    results,
    ...(errors.length ? { errors } : {}),
  }
}
