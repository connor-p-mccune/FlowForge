// The engine resolves {{node-id.field}} placeholders in config.template before
// this runner is called, so the template is usually a JSON string (or already
// an object when the template was a single exact placeholder).
module.exports = async function runTransform(config, input) {
  const template = config.template
  if (template == null || template === '') return { ...input }
  if (typeof template === 'object') return template
  try {
    return JSON.parse(template)
  } catch {
    return { value: template }
  }
}
