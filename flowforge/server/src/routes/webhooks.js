const express = require('express')
const router = express.Router()

// Phase 5: webhook triggers not yet implemented
// Note: this is a public route — no auth middleware applied
router.all('/webhooks*', (req, res) => {
  res.status(501).json({ error: 'Webhook triggers not yet implemented (Phase 5)' })
})

module.exports = router
