const { callAiService } = require('../aiClient')

function hasFields(fields) {
  return Array.isArray(fields) ? fields.length > 0 : Boolean(String(fields || '').trim())
}

// Extracts structured fields from text via the Python AI service.
// config: { text, fields } — text supports templates (falls back to upstream
// input); fields is an array or a comma-separated string.
module.exports = async function runExtract(config, input) {
  const text =
    config.text || (input && typeof input === 'object' ? JSON.stringify(input) : String(input ?? ''))
  if (!text) throw new Error('Extract node: text is required')
  if (!hasFields(config.fields)) throw new Error('Extract node: fields are required')

  const data = await callAiService('/extract', { text, fields: config.fields })
  return { data: data.data }
}
