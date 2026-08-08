const { callAiService } = require('../aiClient')

// Runs a free-form LLM prompt via the Python AI service.
// config: { prompt, system } — prompt supports {{node-id.field}} templates.
module.exports = async function runLlmPrompt(config) {
  const { prompt, system } = config
  if (!prompt) throw new Error('AI Prompt node: prompt is required')
// `usage` is passed straight through when the AI service reports it: the
// engine reads it to price the step and strips it before the value becomes
// node output, so it never reaches downstream data. Omitted when absent, so a
// service that doesn't report usage yields a step with no cost row rather than
// a zero-token one that would look like a free call.
  const data = await callAiService('/llm', { prompt, system })
  return { text: data.text, ...(data.usage ? { usage: data.usage } : {}) }
}
