// flowforge workspaces — the workspaces visible to the token
// (GET /api/v1/workspaces). The ID column is what `import` takes as its target.

const { table, gray } = require('../format')

module.exports = async function workspaces(args, ctx) {
  const { workspaces: list } = await ctx.api.get('/api/v1/workspaces')
  if (!list || list.length === 0) {
    ctx.log('No workspaces visible to this token.')
    return 0
  }
  ctx.log(
    table(
      list.map((w) => ({ id: gray(w.id), name: w.name })),
      [
        { key: 'id', label: 'ID' },
        { key: 'name', label: 'Name' },
      ]
    )
  )
  return 0
}
