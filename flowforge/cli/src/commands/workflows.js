// flowforge workflows — every workflow visible to the token, newest first.
// The id column is what `flowforge trigger <id>` takes.

const { table, statusColored, gray } = require('../format')

module.exports = async function workflows(args, ctx) {
  const { workflows: list } = await ctx.api.get('/api/v1/workflows')
  if (!list || list.length === 0) {
    ctx.log('No workflows visible to this token.')
    return 0
  }
  ctx.log(
    table(
      list.map((wf) => ({
        id: gray(wf.id),
        name: wf.name,
        status: statusColored(wf.status),
        updated: wf.updated_at ?? '',
      })),
      [
        { key: 'id', label: 'ID' },
        { key: 'name', label: 'NAME' },
        { key: 'status', label: 'STATUS' },
        { key: 'updated', label: 'UPDATED' },
      ]
    )
  )
  return 0
}
