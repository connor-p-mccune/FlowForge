const { callAiService } = require('../aiClient')

// Runs a free-form LLM prompt via the Python AI service.
// config: { prompt, system } — prompt supports {{node-id.field}} templates.
module.exports = async function runLlmPrompt(config) {
  const { prompt, system } = config
  if (!prompt) throw new Error('AI Prompt node: prompt is required')
  const data = await callAiService('/llm', { prompt, system })
  return { text: data.text }
}
