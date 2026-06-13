// Posts a message to a Slack incoming webhook.
// config: { webhookUrl, text } — text supports {{node-id.field}} templates,
// which the execution engine resolves before this runner is called.
module.exports = async function runSendSlack(config, input) {
  const { webhookUrl, text } = config
  if (!webhookUrl) throw new Error('Slack node: webhookUrl is required')

  const message =
    text || (input && typeof input === 'object' ? JSON.stringify(input) : String(input ?? ''))

  const res = await fetch(webhookUrl, {
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
