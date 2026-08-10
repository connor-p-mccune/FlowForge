// A type checker for FXL.
//
// `analyze()` answers "does this parse, and does it call anything that doesn't
// exist?". That catches the mistakes visible without knowing the data. This
// module catches the rest: `total * status` where status is an object,
// `sum(order)` where order isn't a list, `items.length` (which is a number in a
// `{{…}}` template and silently `undefined` in FXL), `dateAdd(t, 1, "weeks")`,
// `amount > 100` where the field is spelled `amount_usd`.
//
// It is a single bottom-up pass over the AST: each node's type is computed from
// its children's, checked against what the operator or function requires, and
// handed back up. There is no inference variable and no unification, because
// FXL has no lambdas and no let-bindings — every expression's type is fully
// determined by its leaves, so a plain synthesis pass is the whole algorithm.
//
// **The governing rule is that a diagnostic must be provable.** Every check
// starts from `possibleKinds`, which returns null for a dynamic type, and any
// rule facing a null stands down. A checker that guesses would train people to
// ignore it, which is worse than not having one — so the failure mode here is
// always silence, never a maybe.
//
// Severity follows the linter's contract. **error** means the expression will
// throw or certainly misfire (arithmetic on an object, a bad argument, a field
// that cannot exist). **warning** means it is legal but computes something
// nobody wants — comparing two objects with `<`, which stringifies both to
// "[object Object]" and always reports equal.
//
// Unknown *function names* are deliberately not reported here: `analyze()`
// already owns that finding, and duplicating it would double every message in
// the linter. An unknown call yields `unknown` so the rest of the expression
// still checks.

const T = require('../types')
const { parse } = require('./parser')
const { ExpressionError } = require('./errors')
const { FUNCTION_ARITY } = require('./functions')

// — the shapes the stdlib actually demands ——————————————————————————————

// What `num()` coerces without throwing. Anything outside this set is a
// guaranteed runtime error in every arithmetic position.
const NUMERIC = T.unionOf([T.NUMBER, T.STRING, T.BOOLEAN])
// What `toDate()` accepts: an ISO string or epoch milliseconds.
const DATE_LIKE = T.unionOf([T.STRING, T.NUMBER])
const ANY_ARRAY = T.arrayOf(T.UNKNOWN)
const LIST_OR_TEXT = T.unionOf([ANY_ARRAY, T.STRING])
const STRING_ARRAY = T.arrayOf(T.STRING)

const DATE_UNITS = ['seconds', 'minutes', 'hours', 'days']

// The element type of an array (joined across a union of arrays).
function elementOf(type) {
  const t = type || T.UNKNOWN
  if (t.kind === 'array') return t.element
  if (t.kind === 'union') return T.joinAll(t.options.map(elementOf))
  return T.UNKNOWN
}

// Could a value of `argType` satisfy `paramType`? Compared at the level of
// *kinds* rather than structurally: a signature says "an array" or "something
// numeric", never "an array of exactly these objects", so kind overlap is the
// honest granularity. Dynamic on either side is always compatible.
function compatible(paramType, argType) {
  if (!paramType) return true
  const want = T.possibleKinds(paramType)
  const got = T.possibleKinds(argType)
  if (want === null || got === null) return true
  for (const kind of got) if (want.has(kind)) return true
  return false
}

// — the signature table ——————————————————————————————————————————————————
//
// `params` lists the type each positional argument must be able to satisfy;
// `null` means the function coerces anything (`upper(x)` stringifies whatever
// it is given, so there is nothing to refuse). `rest` types a variadic tail.
// `returns` is a type, or a function of the argument types for the handful that
// are genuinely polymorphic (`first` returns its array's element type).
//
// Arity is *not* declared here — it is read from the registry itself, so this
// table cannot drift out of step with how many arguments a function takes.
const SIGNATURES = {
  // — type + coalescing —
  type: { params: [null], returns: T.STRING },
  string: { params: [null], returns: T.STRING },
  number: { params: [NUMERIC], returns: T.NUMBER },
  bool: { params: [null], returns: T.BOOLEAN },
  isEmpty: { params: [null], returns: T.BOOLEAN },
  default: { params: [null, null], returns: (args) => T.join(args[0], args[1]) },
  coalesce: { params: [], rest: null, returns: (args) => T.joinAll(args) },
  json: { params: [null], returns: T.STRING },
  // Whatever a JSON string parses to is dynamic by definition.
  parseJson: { params: [null], returns: T.ANY },

  len: { params: [null], returns: T.NUMBER },

  // — strings —
  upper: { params: [null], returns: T.STRING },
  lower: { params: [null], returns: T.STRING },
  trim: { params: [null], returns: T.STRING },
  contains: { params: [null, null], returns: T.BOOLEAN },
  startsWith: { params: [null, null], returns: T.BOOLEAN },
  endsWith: { params: [null, null], returns: T.BOOLEAN },
  replace: { params: [null, null, null], returns: T.STRING },
  split: { params: [null, null], returns: STRING_ARRAY },
  substr: { params: [null, NUMERIC, NUMERIC], returns: T.STRING },
  padStart: { params: [null, NUMERIC, null], returns: T.STRING },
  padEnd: { params: [null, NUMERIC, null], returns: T.STRING },
  indexOf: { params: [null, null], returns: T.NUMBER },

  // — numbers / math —
  abs: { params: [NUMERIC], returns: T.NUMBER },
  round: { params: [NUMERIC, NUMERIC], returns: T.NUMBER },
  floor: { params: [NUMERIC], returns: T.NUMBER },
  ceil: { params: [NUMERIC], returns: T.NUMBER },
  sqrt: { params: [NUMERIC], returns: T.NUMBER },
  pow: { params: [NUMERIC, NUMERIC], returns: T.NUMBER },
  // min/max take either a single array or a loose list of numbers, so their
  // argument rule can't be positional — see checkCall.
  min: { params: [], rest: null, returns: T.NUMBER, numericOrSingleArray: true },
  max: { params: [], rest: null, returns: T.NUMBER, numericOrSingleArray: true },
  clamp: { params: [NUMERIC, NUMERIC, NUMERIC], returns: T.NUMBER },
  sum: { params: [ANY_ARRAY], returns: T.NUMBER },
  avg: { params: [ANY_ARRAY], returns: T.NUMBER },

  // — statistics —
  median: { params: [ANY_ARRAY], returns: T.NUMBER },
  percentile: { params: [ANY_ARRAY, NUMERIC], returns: T.NUMBER },
  variance: { params: [ANY_ARRAY], returns: T.NUMBER },
  stddev: { params: [ANY_ARRAY], returns: T.NUMBER },

  // — arrays —
  first: { params: [ANY_ARRAY], returns: (args) => elementOf(args[0]) },
  last: { params: [ANY_ARRAY], returns: (args) => elementOf(args[0]) },
  join: { params: [ANY_ARRAY, null], returns: T.STRING },
  reverse: { params: [ANY_ARRAY], returns: (args) => T.arrayOf(elementOf(args[0])) },
  sort: { params: [ANY_ARRAY], returns: (args) => T.arrayOf(elementOf(args[0])) },
  unique: { params: [ANY_ARRAY], returns: (args) => T.arrayOf(elementOf(args[0])) },
  // slice is the one function that works on both a list and a string, and
  // returns whichever it was given.
  slice: {
    params: [LIST_OR_TEXT, NUMERIC, NUMERIC],
    returns: (args) => (T.is(args[0], 'string') ? T.STRING : T.arrayOf(elementOf(args[0]))),
  },

  // — sets and patterns —
  // The set helpers preserve their first argument's element type: filtering a
  // list of strings still gives a list of strings, which is what lets a policy
  // chain `len(notMatching(hosts, allowed)) == 0` and still typecheck.
  without: { params: [ANY_ARRAY, ANY_ARRAY], returns: (args) => T.arrayOf(elementOf(args[0])) },
  intersect: { params: [ANY_ARRAY, ANY_ARRAY], returns: (args) => T.arrayOf(elementOf(args[0])) },
  flatten: {
    params: [ANY_ARRAY],
    // One level of unwrapping: an array element flattens to *its* elements,
    // anything else stays as it is.
    returns: (args) => {
      const element = elementOf(args[0])
      return T.arrayOf(element.kind === 'array' ? element.element : element)
    },
  },
  matches: { params: [null, null], returns: T.BOOLEAN },
  // The pattern argument is one glob or a list of them, so it is deliberately
  // untyped rather than refused.
  matching: { params: [ANY_ARRAY, null], returns: (args) => T.arrayOf(elementOf(args[0])) },
  notMatching: { params: [ANY_ARRAY, null], returns: (args) => T.arrayOf(elementOf(args[0])) },

  // — objects — all tolerant: they answer for a non-object rather than throwing.
  keys: { params: [null], returns: STRING_ARRAY },
  values: { params: [null], returns: (args) => T.arrayOf(fieldValueType(args[0])) },
  has: { params: [null, null], returns: T.BOOLEAN },
  get: { params: [null, null, null], returns: T.ANY, resolvesPath: true },

  // — time —
  now: { params: [], returns: T.STRING },
  nowMs: { params: [], returns: T.NUMBER },

  // — dates —
  parseDate: { params: [DATE_LIKE], returns: T.STRING },
  year: { params: [DATE_LIKE], returns: T.NUMBER },
  month: { params: [DATE_LIKE], returns: T.NUMBER },
  day: { params: [DATE_LIKE], returns: T.NUMBER },
  hour: { params: [DATE_LIKE], returns: T.NUMBER },
  minute: { params: [DATE_LIKE], returns: T.NUMBER },
  weekday: { params: [DATE_LIKE], returns: T.NUMBER },
  dateAdd: { params: [DATE_LIKE, NUMERIC, T.STRING], returns: T.STRING, unitArg: 2 },
  dateDiff: { params: [DATE_LIKE, DATE_LIKE, T.STRING], returns: T.NUMBER, unitArg: 2 },
  isBefore: { params: [DATE_LIKE, DATE_LIKE], returns: T.BOOLEAN },
  isAfter: { params: [DATE_LIKE, DATE_LIKE], returns: T.BOOLEAN },
}

// The join of an object's field types — what `values(obj)` yields.
function fieldValueType(type) {
  const t = type || T.UNKNOWN
  if (t.kind !== 'object') return T.UNKNOWN
  return T.joinAll(Object.values(t.fields).map((f) => f.type))
}

// — the checker ——————————————————————————————————————————————————————————

const ARITHMETIC = new Set(['-', '*', '/', '%'])
const RELATIONAL = new Set(['<', '<=', '>', '>='])
const EQUALITY = new Set(['==', '!=', '===', '!=='])

// Types whose values have no useful ordering or textual form — comparing or
// doing arithmetic with one is a mistake rather than a choice.
function isStructural(type) {
  const kinds = T.possibleKinds(type)
  if (kinds === null) return false
  for (const k of kinds) if (k !== 'array' && k !== 'object') return false
  return true
}

// Check an FXL AST against a type environment.
//
//   env      an object type describing the scope's identifiers. A dynamic or
//            open env silences the unknown-identifier check, which is what
//            makes this safe to run against a webhook body nobody has typed.
//
// Returns { type, diagnostics: [{ severity, code, message, position }] }.
function checkTypes(ast, env = T.UNKNOWN) {
  const diagnostics = []
  const scope = env || T.UNKNOWN

  const report = (severity, code, message, node) =>
    diagnostics.push({ severity, code, message, position: node?.position ?? null })

  function walk(node) {
    if (!node || typeof node !== 'object') return T.UNKNOWN
    switch (node.type) {
      case 'Literal':
        return literalType(node.value)

      case 'Identifier': {
        const found = T.lookup(scope, node.name, 'expression')
        if (found.exists === 'no') {
          const hint = T.suggest(node.name, T.fieldNames(scope))
          report(
            'error',
            'unknown-identifier',
            `"${node.name}" is not in scope here${hint ? ` — did you mean "${hint}"?` : ''}`,
            node
          )
          return T.UNKNOWN
        }
        return found.type
      }

      case 'Array':
        return T.arrayOf(T.joinAll(node.elements.map(walk)))

      case 'Object': {
        const shape = {}
        for (const prop of node.properties) shape[prop.key] = walk(prop.value)
        return T.objectOf(shape)
      }

      case 'Member':
        return checkMember(node)

      case 'Call':
        return checkCall(node)

      case 'Unary': {
        const argument = walk(node.argument)
        if (node.op === '!') return T.BOOLEAN
        if (!T.mayBeNumeric(argument)) {
          report(
            'error',
            'operand-type',
            `unary "${node.op}" needs a number, but this is ${T.describe(argument)}`,
            node
          )
        }
        return T.NUMBER
      }

      // `&&` yields the right operand when the left is truthy and the left
      // otherwise; `||` is the mirror. Both can produce either side's value, so
      // the type is the join — which is what makes `x || "fallback"` come out
      // as `string` when x is a string.
      case 'Logical':
        return T.join(walk(node.left), walk(node.right))

      case 'Conditional': {
        walk(node.test)
        return T.join(walk(node.consequent), walk(node.alternate))
      }

      case 'Binary':
        return checkBinary(node)

      default:
        return T.UNKNOWN
    }
  }

  function checkMember(node) {
    const base = walk(node.object)
    let key = node.property
    if (node.computed) {
      walk(node.property)
      if (node.property?.type !== 'Literal') {
        // A computed key we can't evaluate: the element type for a list, and
        // nothing to say for anything else.
        return T.mayBe(base, 'array') ? elementOf(base) : T.UNKNOWN
      }
      key = node.property.value
    }
    const found = T.lookup(base, key, 'expression')
    if (found.exists === 'no') {
      const names = T.fieldNames(base)
      const hint = T.suggest(key, names)
      // The single most valuable message this checker produces: `.length` is a
      // number in a {{…}} template and undefined in FXL, and nothing else in
      // the product will ever tell you.
      const aside =
        (base.kind === 'array' || base.kind === 'string') && String(key) === 'length'
          ? ' — expressions have no ".length"; use len(…)'
          : hint
            ? ` — did you mean "${hint}"?`
            : ''
      report(
        'error',
        'no-such-field',
        `${T.describe(base)} has no field "${key}"${aside}`,
        node
      )
      return T.UNKNOWN
    }
    return found.type
  }

  function checkBinary(node) {
    const left = walk(node.left)
    const right = walk(node.right)
    const op = node.op

    if (ARITHMETIC.has(op)) {
      for (const [side, type] of [['left', left], ['right', right]]) {
        if (!T.mayBeNumeric(type)) {
          report(
            'error',
            'operand-type',
            `"${op}" needs numbers, but the ${side} side is ${T.describe(type)}`,
            node
          )
        }
      }
      return T.NUMBER
    }

    if (op === '+') {
      // `+` concatenates when either side is a string and adds otherwise, so
      // it only fails when neither side can be a string *and* one of them
      // can't be a number.
      const eitherStringy = T.mayBe(left, 'string') || T.mayBe(right, 'string')
      if (!eitherStringy) {
        for (const [side, type] of [['left', left], ['right', right]]) {
          if (!T.mayBeNumeric(type)) {
            report(
              'error',
              'operand-type',
              `"+" cannot add ${T.describe(type)} (the ${side} side) — neither side is text, so this is arithmetic`,
              node
            )
          }
        }
      }
      if (T.is(left, 'string') || T.is(right, 'string')) return T.STRING
      if (!eitherStringy) return T.NUMBER
      return T.unionOf([T.STRING, T.NUMBER])
    }

    if (RELATIONAL.has(op)) {
      // The evaluator falls back to comparing string forms, so an object never
      // throws here — it just compares "[object Object]" against itself and
      // reports equal, forever. Legal, useless, and worth saying out loud.
      for (const [side, type] of [['left', left], ['right', right]]) {
        if (isStructural(type)) {
          report(
            'warning',
            'meaningless-comparison',
            `"${op}" compares ${T.describe(type)} (the ${side} side) as text — every comparison of two objects reports equal`,
            node
          )
        }
      }
      return T.BOOLEAN
    }

    if (EQUALITY.has(op)) {
      const structuralLeft = isStructural(left)
      const structuralRight = isStructural(right)
      if (structuralLeft !== structuralRight && !T.isDynamic(left) && !T.isDynamic(right)) {
        report(
          'warning',
          'always-false',
          `comparing ${T.describe(left)} with ${T.describe(right)} is always ${op.startsWith('!') ? 'true' : 'false'}`,
          node
        )
      }
      return T.BOOLEAN
    }

    if (op === 'in') {
      if (!T.mayBeContainer(right)) {
        report(
          'warning',
          'always-false',
          `"in" searches a list, text, or object — ${T.describe(right)} has no members, so this is always false`,
          node
        )
      }
      return T.BOOLEAN
    }

    return T.UNKNOWN
  }

  function checkCall(node) {
    const argTypes = node.args.map(walk)
    const arity = FUNCTION_ARITY[node.callee]
    // Unknown function: analyze() reports it; here it simply has no type.
    if (!arity) return T.UNKNOWN
    const [min, max] = arity
    if (argTypes.length < min || argTypes.length > max) {
      const range =
        min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`
      report(
        'error',
        'arity',
        `${node.callee}() takes ${range} argument(s), got ${argTypes.length}`,
        node
      )
      return T.UNKNOWN
    }

    const signature = SIGNATURES[node.callee]
    if (!signature) return T.UNKNOWN

    if (signature.numericOrSingleArray) {
      // min/max: one array, or a loose list of numbers.
      const singleArray = argTypes.length === 1 && T.mayBe(argTypes[0], 'array')
      if (!singleArray) {
        argTypes.forEach((argType, i) => {
          if (!T.mayBeNumeric(argType)) {
            report(
              'error',
              'argument-type',
              `${node.callee}() argument ${i + 1} must be a number or a list of numbers, got ${T.describe(argType)}`,
              node.args[i]
            )
          }
        })
      }
    } else {
      argTypes.forEach((argType, i) => {
        // A declared parameter of `null` means "coerces anything"; past the end
        // of the list, `rest` types the variadic tail (undefined = unchecked).
        const param = i < signature.params.length ? signature.params[i] : signature.rest
        if (param === undefined) return
        if (!compatible(param, argType)) {
          report(
            'error',
            'argument-type',
            `${node.callee}() argument ${i + 1} expects ${T.describe(param)}, got ${T.describe(argType)}`,
            node.args[i]
          )
        }
      })
    }

    // dateAdd/dateDiff take a unit from a closed set. When it's written as a
    // literal — which it almost always is — a wrong one is knowable now rather
    // than on the run that needed it.
    if (signature.unitArg !== undefined) {
      const unitNode = node.args[signature.unitArg]
      if (unitNode?.type === 'Literal' && typeof unitNode.value === 'string') {
        if (!DATE_UNITS.includes(unitNode.value)) {
          report(
            'error',
            'invalid-unit',
            `${node.callee}() unit must be one of ${DATE_UNITS.join(', ')} — got "${unitNode.value}"`,
            unitNode
          )
        }
      }
    }

    // get(obj, "a.b") with a literal path is a member access in disguise, so
    // resolve it properly instead of shrugging and returning `any`.
    if (signature.resolvesPath) {
      const pathNode = node.args[1]
      if (pathNode?.type === 'Literal' && typeof pathNode.value === 'string') {
        const resolved = T.lookupPath(argTypes[0], pathNode.value.split('.'), 'template')
        if (resolved.exists !== 'no') {
          const fallback = argTypes[2]
          return fallback ? T.join(resolved.type, fallback) : resolved.type
        }
      }
      return T.ANY
    }

    return typeof signature.returns === 'function'
      ? signature.returns(argTypes, node.args)
      : signature.returns
  }

  const type = walk(ast)
  return { type, diagnostics }
}

function literalType(value) {
  if (value === null) return T.NULL
  switch (typeof value) {
    case 'number':
      return T.NUMBER
    case 'string':
      return T.STRING
    case 'boolean':
      return T.BOOLEAN
    default:
      return T.UNKNOWN
  }
}

// Parse and check in one call, for callers holding a source string.
// { ok, error?, position?, type, diagnostics } — a parse failure reports itself
// the same way `check()` does rather than throwing, because every caller here
// is rendering the problem, not handling it.
function typeCheck(source, env = T.UNKNOWN) {
  if (source == null || String(source).trim() === '') {
    return { ok: false, empty: true, error: 'Expression is empty', type: T.UNKNOWN, diagnostics: [] }
  }
  let ast
  try {
    ast = parse(String(source))
  } catch (err) {
    if (err instanceof ExpressionError) {
      return {
        ok: false,
        error: err.message,
        position: err.position ?? null,
        type: T.UNKNOWN,
        diagnostics: [],
      }
    }
    throw err
  }
  const { type, diagnostics } = checkTypes(ast, env)
  return { ok: true, type, diagnostics }
}

module.exports = { checkTypes, typeCheck, SIGNATURES, elementOf, NUMERIC, DATE_LIKE }
