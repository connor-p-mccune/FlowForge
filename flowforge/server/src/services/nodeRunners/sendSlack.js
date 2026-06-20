const { safeFetch } = require('../ssrfGuard')

// Posts a message to a Slack incoming webhook.
// config: { webhookUrl, text } — text supports {{node-id.field}} templates,
// which the execution engine resolves before this runner is called.
// isDryRun (test mode): skip the POST and report what would have been sent.
// webhookUrl is a user-supplied URL, so the POST goes through the SSRF guard.
module.exports = async function runSendSlack(config, input, isDryRun) {
  const { webhookUrl, text } = config
  if (!webhookUrl) throw new Error('Slack node: webhookUrl is required')

  const message =
    text || (input && typeof input === 'object' ? JSON.stringify(input) : String(input ?? ''))

  // The incoming-webhook URL *is* the destination (the Slack channel is baked
  // into it server-side), so report it as `channel` alongside the message.
  if (isDryRun) {
    return { dryRun: true, wouldHaveSent: { channel: webhookUrl, message } }
  }

  const res = await safeFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`Slack webhook failed (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }

  return { ok: true, text: message }
}
