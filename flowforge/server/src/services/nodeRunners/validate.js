// Validate node: check a payload against a JSON Schema and route the run down the
// valid or invalid branch. Like the condition and switch nodes it's a *branching*
// node — it settles a `result` of 'valid' | 'invalid' that the engine matches
// against each outgoing edge's sourceHandle — so a workflow can accept a webhook
// body only when it has the shape it expects and divert malformed input to an
// error branch instead of failing deep inside a later node.
//
//   config.schema  a JSON Schema (a JSON string, or already an object). Validated
//                  against services/jsonSchema.js — a dependency-free draft-07
//                  subset.
//   config.source  optional template resolving to the value to validate; falls
//                  back to the node's merged input when blank.
//
// Output: { result, valid, errors, data }. `errors` is the list of
// { path, message } failures (empty when valid), so the invalid branch can log
// or report exactly what was wrong. Validation is pure (no side effects), so —
// like condition/switch — it runs for real even in dry-run mode.

const { validate } = require('../jsonSchema')

// Resolve the schema config (already run through templating) to an object: an
// object as-is, or a JSON string parsed. Anything else is a config error.
function resolveSchema(schema) {
  if (schema && typeof schema === 'object') return schema
  if (typeof schema === 'string' && schema.trim() !== '') {
    try {
      return JSON.parse(schema)
    } catch {
      throw new Error('Validate node: schema is not valid JSON')
    }
  }
  throw new Error('Validate node requires a JSON Schema')
}

module.exports = async function runValidate(config, input = {}) {
  const schema = resolveSchema(config?.schema)

  // The value to validate: an explicit source (already templated) if given,
  // otherwise the node's merged upstream input.
  let data = config?.source
  if (data === undefined || data === null || data === '') data = input
  if (typeof data === 'string') {
    // A source template can resolve to a JSON string (e.g. a raw HTTP body);
    // parse it so the schema validates structure, not the string form.
    const trimmed = data.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        data = JSON.parse(trimmed)
      } catch {
        /* not JSON — validate the string value as-is */
      }
    }
  }

  const { valid, errors } = validate(schema, data)
  return { result: valid ? 'valid' : 'invalid', valid, errors, data }
}
