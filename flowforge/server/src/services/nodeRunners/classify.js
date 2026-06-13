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

  const data = await callAiService('/classify', { text, labels: config.labels })
  return { label: data.label }
}
