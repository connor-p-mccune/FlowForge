// flowforge login --url <server> --token <ffp_…> — store credentials in
// ~/.flowforge.json after proving they work with one authenticated request.
// Env vars (FLOWFORGE_URL / FLOWFORGE_TOKEN) always take precedence over the
// file, so CI never needs this command.

const { writeConfig } = require('../config')
const { createClient } = require('../api')

module.exports = async function login(args, ctx) {
  const url = args.flags.url && String(args.flags.url).replace(/\/+$/, '')
  const token = args.flags.token && String(args.flags.token)
  if (!url || !token) {
    ctx.log('Usage: flowforge login --url https://your-flowforge-host --token ffp_…')
    ctx.log('Mint a token in Settings → API tokens (scopes: trigger, read).')
    return 1
  }

  // Verify before persisting — a typo'd token should fail here, not on the
  // next real command.
  const api = ctx.apiForLogin || createClient({ baseUrl: url, token })
  const { workflows } = await api.get('/api/v1/workflows')

  const path = writeConfig({ url, token })
  ctx.log(`Logged in — ${workflows.length} workflow(s) visible. Config saved to ${path}.`)
  return 0
}
