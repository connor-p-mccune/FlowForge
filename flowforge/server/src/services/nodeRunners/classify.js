const { callAiService } = require('../aiClient')

function hasLabels(labels) {
  return Array.isArray(labels) ? labels.length > 0 : Boolean(String(labels || '').trim())
}

// Classifies text into one of a fixed set of labels via the Python AI service.
// config: { text, labels } — text supports templates (falls back to upstream
// input); labels is an array or a comma-separated string.
module.exports = async function runClassify(config, input) {
  const text =
    config.text || (input && typeof input === 'object' ? JSON.stringify(input) : String(input ?? ''))
  if (!text) throw new Error('Classify node: text is required')
  if (!hasLabels(config.labels)) throw new Error('Classify node: labels are required')

// `usage` is passed straight through when the AI service reports it: the
// engine reads it to price the step and strips it before the value becomes
// node output, so it never reaches downstream data. Omitted when absent, so a
// service that doesn't report usage yields a step with no cost row rather than
// a zero-token one that would look like a free call.
  const data = await callAiService('/classify', { text, labels: config.labels })
  return { label: data.label, ...(data.usage ? { usage: data.usage } : {}) }
}
