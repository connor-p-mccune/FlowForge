// Public callback delivery: the wait-for-callback node's inbound half. The
// token is the whole credential — 48 random hex chars minted per run per node,
// armed before anything executes and retired when the run settles — so the
// route is deliberately anonymous, rate-limited like the other public intake
// (webhook triggers), and never names a workflow or workspace in a response.

const express = require('express')
const db = require('../config/database')
const { webhookLimiter } = require('../middleware/rateLimit')

const router = express.Router()

// POST /api/callbacks/:token — deliver a payload to a waiting run. The JSON
// body becomes the wait node's `payload` output. Accepted while the callback
// is 'armed' (the reply beat the runner to the node — it settles instantly on
// arrival) or 'waiting'. The status-guarded UPDATE makes delivery first-wins:
// a duplicate gets a 409 with the settled state, a delivery to an expired or
// retired token gets a 410 — either way the original payload is untouched.
router.post('/callbacks/:token', webhookLimiter, (req, res) => {
  try {
    const row = db
      .prepare('SELECT * FROM execution_callbacks WHERE token = ?')
      .get(req.params.token)
    if (!row) return res.status(404).json({ error: 'Callback not found' })

    if (row.status === 'armed' || row.status === 'waiting') {
      const payload = req.body && typeof req.body === 'object' ? req.body : {}
      const { changes } = db
        .prepare(
          `UPDATE execution_callbacks SET status = 'received', payload_json = ?, received_at = ?
           WHERE id = ? AND status IN ('armed', 'waiting')`
        )
        .run(JSON.stringify(payload), new Date().toISOString(), row.id)
      if (changes > 0) return res.status(202).json({ status: 'received' })
      // Lost a race — a concurrent delivery or the runner's own timeout/cancel
      // settled the row this instant. Fall through and report what won.
    }

    const current = db.prepare('SELECT status FROM execution_callbacks WHERE id = ?').get(row.id)
    if (current.status === 'received') {
      return res.status(409).json({ error: 'Callback already delivered', status: 'received' })
    }
    return res
      .status(410)
      .json({ error: 'Callback is no longer waiting', status: current.status })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

module.exports = router
