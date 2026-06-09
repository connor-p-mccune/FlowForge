const express = require('express')
const router = express.Router()

// Phase 3: execution engine not yet implemented
router.all('/executions*', (req, res) => {
  res.status(501).json({ error: 'Execution engine not yet implemented (Phase 3)' })
})

router.all('/workflows/:id/execute', (req, res) => {
  res.status(501).json({ error: 'Execution engine not yet implemented (Phase 3)' })
})

module.exports = router
