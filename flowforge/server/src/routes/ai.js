const express = require('express')
const auth = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { callAiService } = require('../services/aiClient')

const router = express.Router()

// POST /api/ai/suggest — proxy next-step suggestions from the Python AI service.
router.post(
  '/ai/suggest',
  auth,
  validate({
    nodes: { type: 'array', maxItems: 2000 },
    edges: { type: 'array', maxItems: 5000 },
    lastNodeType: { type: 'string', maxLength: 100 },
  }),
  async (req, res) => {
  try {
    const { nodes = [], edges = [], lastNodeType = null } = req.body || {}
    const data = await callAiService('/suggest', { nodes, edges, lastNodeType })
    res.json({ suggestions: data.suggestions || [] })
  } catch (err) {
    console.error('AI suggest failed:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// POST /api/ai/generate — turn a plain-English description into a full workflow
// graph via the Python AI service. Returns { graph_data: { nodes, edges } } the
// canvas can load directly.
router.post(
  '/ai/generate',
  auth,
  validate({ prompt: { required: true, type: 'string', maxLength: 2000 } }),
  async (req, res) => {
    try {
      const { prompt } = req.body
      const data = await callAiService('/generate', { prompt })
      res.json({ graph_data: data.graph_data })
    } catch (err) {
      console.error('AI generate failed:', err.message)
      res.status(502).json({ error: err.message })
    }
  }
)

module.exports = router
