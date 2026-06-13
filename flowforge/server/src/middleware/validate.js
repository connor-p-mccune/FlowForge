// Lightweight request-body validation.
//
// Routes declare a small schema mapping each field to a set of rules:
//   validate({
//     name:  { required: true, type: 'string', maxLength: 200 },
//     nodes: { required: true, type: 'array' },
//     method:{ type: 'string', oneOf: ['GET', 'POST'] },
//   })
//
// On the first failing rule the middleware responds with a consistent
// { error: string } body and HTTP 400 — matching the shape every other
// endpoint uses — so the frontend can surface a single message. Checks run
// required → type → length → enum so the error always names the real problem.

// Hard cap applied to any string field that doesn't set its own maxLength.
// Guards against unbounded payloads (the JSON body limit in index.js is the
// outer backstop; this keeps individual fields sane).
const DEFAULT_MAX_STRING = 10000

const ARTICLE = { array: 'an', object: 'an' } // a/an for nicer messages

function checkType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

// A field counts as "absent" when it's undefined/null or a blank string. This
// makes `required` reject empty and whitespace-only values, while optional
// fields simply skip the remaining checks when omitted.
function isAbsent(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  return false
}

function validate(schema) {
  return (req, res, next) => {
    const body = req.body || {}
    for (const [field, rule] of Object.entries(schema)) {
      const value = body[field]

      if (isAbsent(value)) {
        if (rule.required) {
          return res.status(400).json({ error: `${field} is required` })
        }
        continue
      }

      if (rule.type && !checkType(value, rule.type)) {
        const article = ARTICLE[rule.type] || 'a'
        return res.status(400).json({ error: `${field} must be ${article} ${rule.type}` })
      }

      if (typeof value === 'string') {
        const max = rule.maxLength ?? DEFAULT_MAX_STRING
        if (value.length > max) {
          return res.status(400).json({ error: `${field} must be at most ${max} characters` })
        }
        if (rule.minLength && value.length < rule.minLength) {
          return res.status(400).json({ error: `${field} must be at least ${rule.minLength} characters` })
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          return res.status(400).json({ error: rule.patternMessage || `${field} is invalid` })
        }
      }

      if (Array.isArray(value) && rule.maxItems != null && value.length > rule.maxItems) {
        return res.status(400).json({ error: `${field} must have at most ${rule.maxItems} items` })
      }

      if (rule.oneOf && !rule.oneOf.includes(value)) {
        return res.status(400).json({ error: `${field} must be one of: ${rule.oneOf.join(', ')}` })
      }
    }
    next()
  }
}

// Kept for backward compatibility; prefer validate({ field: { required: true } }).
function requireFields(...fields) {
  return validate(Object.fromEntries(fields.map((f) => [f, { required: true }])))
}

// Loose email shape check — intentionally permissive (one @, a dot in the
// domain). Real deliverability isn't validated here.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

module.exports = { validate, requireFields, EMAIL_PATTERN }
