// A small, dependency-free JSON Schema validator — enough of draft-07 to guard a
// webhook body or an upstream response before a workflow acts on it, hand-rolled
// in the same spirit as the FXL interpreter and the cron engine: the app needs a
// practical subset, not a spec-complete library (and pulling one in for a handful
// of keywords would be the wrong trade).
//
// validate(schema, data) → { valid, errors: [{ path, message }] }
//   path is a JSON-pointer-ish location ("/items/0/price") so a failure points
//   at the offending field, not just "invalid".
//
// Supported keywords: type (incl. "integer" and unions), enum, const, required,
// properties, additionalProperties (boolean or schema), items (single schema),
// minItems/maxItems, uniqueItems, minimum/maximum/exclusiveMinimum/
// exclusiveMaximum, multipleOf, minLength/maxLength, pattern, format
// (email/uri/date-time, best-effort), and nullable (OpenAPI-style). Unknown
// keywords are ignored rather than erroring — a schema using something exotic
// still validates on what it can, which is the friendly failure mode here.

// JSON type of a value, with a distinct 'integer' checked separately (JSON has no
// integer type — it's a numeric constraint). null is its own type; arrays are
// 'array', not 'object'.
function jsonType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

// Structural equality via canonical JSON, for enum/const. Object key order is
// normalised so { a, b } and { b, a } compare equal.
function deepEqual(a, b) {
  return canonical(a) === canonical(b)
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

const FORMAT_CHECKS = {
  // Deliberately permissive — a light sanity check, not RFC-complete parsing.
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(v),
  'date-time': (v) => !Number.isNaN(Date.parse(v)),
}

function matchesType(value, type) {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number'
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  return jsonType(value) === type
}

// Collect validation errors for `data` against `schema` at `path`, appending to
// `errors`. Recurses into object properties and array items.
function collect(schema, data, path, errors) {
  const err = (message) => errors.push({ path: path || '/', message })

  // A boolean schema: true accepts anything, false rejects everything.
  if (schema === true) return
  if (schema === false) return err('is not allowed here')
  if (!schema || typeof schema !== 'object') return

  // nullable (OpenAPI): null short-circuits the rest of the schema.
  if (schema.nullable && data === null) return

  // type (string or array of acceptable types).
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => matchesType(data, t))) {
      err(`should be ${types.join(' or ')}, got ${jsonType(data)}`)
      // A wrong type makes the value-specific checks below meaningless, so stop
      // here for this node rather than pile on cascading errors.
      return
    }
  }

  if (schema.const !== undefined && !deepEqual(data, schema.const)) {
    err(`should equal ${JSON.stringify(schema.const)}`)
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => deepEqual(data, v))) {
    err(`should be one of ${JSON.stringify(schema.enum)}`)
  }

  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) err(`should be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && data > schema.maximum) err(`should be <= ${schema.maximum}`)
    if (schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
      err(`should be > ${schema.exclusiveMinimum}`)
    }
    if (schema.exclusiveMaximum !== undefined && data >= schema.exclusiveMaximum) {
      err(`should be < ${schema.exclusiveMaximum}`)
    }
    if (schema.multipleOf && data % schema.multipleOf !== 0) {
      err(`should be a multiple of ${schema.multipleOf}`)
    }
  }

  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      err(`should be at least ${schema.minLength} characters`)
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      err(`should be at most ${schema.maxLength} characters`)
    }
    if (schema.pattern !== undefined) {
      let re
      try {
        re = new RegExp(schema.pattern)
      } catch {
        re = null // an invalid pattern in the schema — skip rather than throw
      }
      if (re && !re.test(data)) err(`should match /${schema.pattern}/`)
    }
    if (schema.format && FORMAT_CHECKS[schema.format] && !FORMAT_CHECKS[schema.format](data)) {
      err(`should be a valid ${schema.format}`)
    }
  }

  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      err(`should have at least ${schema.minItems} items`)
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      err(`should have at most ${schema.maxItems} items`)
    }
    if (schema.uniqueItems) {
      const seen = new Set()
      for (const item of data) {
        const key = canonical(item)
        if (seen.has(key)) {
          err('should not contain duplicate items')
          break
        }
        seen.add(key)
      }
    }
    if (schema.items) {
      data.forEach((item, i) => collect(schema.items, item, `${path}/${i}`, errors))
    }
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) {
        err(`is missing required property "${key}"`)
      }
    }
    const properties = schema.properties || {}
    for (const [key, subschema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        collect(subschema, data[key], `${path}/${key}`, errors)
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const key of Object.keys(data)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) continue
        if (schema.additionalProperties === false) {
          err(`has an unexpected property "${key}"`)
        } else {
          collect(schema.additionalProperties, data[key], `${path}/${key}`, errors)
        }
      }
    }
  }
}

function validate(schema, data) {
  const errors = []
  collect(schema, data, '', errors)
  return { valid: errors.length === 0, errors }
}

module.exports = { validate, deepEqual }
