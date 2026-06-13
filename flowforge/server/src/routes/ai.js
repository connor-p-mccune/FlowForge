const express = require('express')
const auth = require('../middleware/auth')
const { callAiService } = require('../services/aiClient')

const router = express.Router()

// POST /api/ai/suggest — proxy next-step suggestions from the Python AI service.
router.post('/ai/suggest', auth, async (req, res) => {
  try {
    const { nodes = [], edges = [], lastNodeType = null } = req.body || {}
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      return res.status(400).json({ error: 'nodes and edges must be arrays' })
    }
    const data = await callAiService('/suggest', { nodes, edges, lastNodeType })
    res.json({ suggestions: data.suggestions || [] })
  } catch (err) {
    console.error('AI suggest failed:', err.message)
    res.status(502).json({ error: err.message })
  }
})

module.exports = router
