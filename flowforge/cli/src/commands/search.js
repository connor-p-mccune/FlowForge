// flowforge search <query…> — full-text search over workflow names,
// descriptions, and graph contents (node labels, config strings, sticky
// notes). "Which workflow calls the stripe API?" from a terminal: the id
// column feeds straight into `flowforge trigger` / `export`. The server
// highlights matched terms with [brackets]; they render bold here.

const { table, statusColored, gray, bold } = require('../format')

// Turn the server's [match] markers into bold terminal text.
function highlight(snippet) {
  return String(snippet).replace(/\[([^\]]*)\]/g, (_, term) => bold(term))
}

module.exports = async function search(args, ctx) {
  const query = args.positionals.join(' ').trim()
  if (!query) {
    ctx.log('Usage: flowforge search <query> [--limit N]')
    return 1
  }

  const params = new URLSearchParams({ q: query })
  if (args.flags.limit) params.set('limit', String(args.flags.limit))
  const { results } = await ctx.api.get(`/api/v1/search?${params}`)

  if (!results || results.length === 0) {
    ctx.log(`No workflows match “${query}”.`)
    return 0
  }

  ctx.log(
    table(
      results.map((r) => ({
        id: gray(r.workflowId),
        name: r.name,
        status: statusColored(r.status),
        match: `${gray(`${r.field}:`)} ${highlight(r.snippet)}`,
      })),
      [
        { key: 'id', label: 'ID' },
        { key: 'name', label: 'NAME' },
        { key: 'status', label: 'STATUS' },
        { key: 'match', label: 'MATCH' },
      ]
    )
  )
  return 0
}
