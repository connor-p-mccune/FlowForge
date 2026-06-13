const nodemailer = require('nodemailer')

// Real SMTP delivery when SMTP_HOST is configured; otherwise a "simulated"
// send that serialises the message without delivering it (clearly flagged in
// the output) so the feature works end-to-end in dev/demo without credentials.
let cached = null

function getTransport() {
  if (cached) return cached
  if (process.env.SMTP_HOST) {
    cached = {
      transport: nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE) === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      }),
      simulated: false,
    }
  } else {
    cached = { transport: nodemailer.createTransport({ jsonTransport: true }), simulated: true }
  }
  return cached
}

// config: { to, subject, body } — all support {{node-id.field}} templates.
module.exports = async function runSendEmail(config, input) {
  const { to, subject, body } = config
  if (!to) throw new Error('Email node: "to" is required')

  const { transport, simulated } = getTransport()
  const text =
    body || (input && typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input ?? ''))

  const info = await transport.sendMail({
    from: process.env.EMAIL_FROM || 'flowforge@example.com',
    to,
    subject: subject || '(no subject)',
    text,
  })

  return {
    sent: true,
    simulated,
    messageId: info.messageId,
    to,
    subject: subject || '(no subject)',
  }
}
