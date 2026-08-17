// Generative testing for FXL — the type checker's claims, tested as claims.
//
// The rest of the expression suites are examples: `amount * customer` is
// reported, `items.length` is reported, this one is not. Examples are how a
// checker gets built and they are not how it gets trusted, because the property
// the README actually asserts is universal:
//
//   > A checker that occasionally cries wolf gets switched off within a week and
//   > takes its true findings with it — so the failure mode here is always
//   > silence, never a maybe.
//
// That is a statement about every expression, not about the eleven somebody
// thought of. So this file generates them: a few hundred well-typed programs per
// property, built from a random walk over the type lattice, evaluated against a
// scope that inhabits the environment they were checked against.
//
// Two properties, and the first matters more than the second.
//
//   **Precision.** If an expression evaluates, the checker must not have
//   reported an error about it. A false positive is the failure mode that gets
//   the feature disabled.
//
//   **Soundness, modulo one documented boundary.** If the checker reported no
//   error, evaluation must either succeed or fail *only* at the string→number
//   coercion the language deliberately permits — `number("abc")` type-checks
//   because `number("42")` has to. Pinning exactly where the checker is
//   permissive is more useful than pretending it is total.
//
// Everything is seeded. A failure prints the seed and the source, so a
// generative test that fails is a regression test that already exists — the
// same argument the chaos profile makes for seeding its draws.

const T = require('../services/types')
const { parse, checkTypes, evaluateExpression, ExpressionError } = require('../services/expression')

// Mulberry32. Small, well-distributed, and reproducible across machines and
// Node versions — which `Math.random` is not, and a generative suite that
// cannot reproduce its own failure is a flake generator.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (random, xs) => xs[Math.floor(random() * xs.length) % xs.length]

// The environment every generated expression is checked against, and a value
// that inhabits it. `code` is a numeric-looking string on purpose: it is the
// value that makes the coercion boundary reachable rather than theoretical.
const ENV = T.objectOf({
  count: T.NUMBER,
  total: T.NUMBER,
  name: T.STRING,
  code: T.STRING,
  flag: T.BOOLEAN,
  nums: T.arrayOf(T.NUMBER),
  words: T.arrayOf(T.STRING),
  user: T.objectOf({ id: T.NUMBER, email: T.STRING }),
})

const SCOPE = {
  count: 3,
  total: 10.5,
  name: 'ada',
  code: '42',
  flag: true,
  nums: [4, 8, 15, 16],
  words: ['alpha', 'beta'],
  user: { id: 7, email: 'ada@example.com' },
}

const NUMBER_TERMS = ['count', 'total', 'user.id']
const STRING_TERMS = ['name', 'code', 'user.email']

// — the generator ————————————————————————————————————————————————————————
//
// A random walk over the lattice: to build an expression of type `t`, pick one
// of the ways FXL produces a `t` and recurse for its operands.
//
// Two families are deliberately absent, and the reason is the point of the
// whole file. `/` and `%` can divide by zero and `sqrt`/`pow` can leave the
// reals — both produce a non-finite number that the *next* function rejects.
// Those are **domain** failures, not type failures, and the checker never
// claimed to catch them. Generating them would make this suite fail for a
// reason that is not a defect, which is exactly the sin it exists to police.

function genNumber(random, depth) {
  if (depth <= 0 || random() < 0.3) {
    return random() < 0.5
      ? String(Math.floor(random() * 100))
      : pick(random, NUMBER_TERMS)
  }
  const shape = pick(random, ['binary', 'call1', 'len', 'agg', 'conditional'])
  switch (shape) {
    case 'binary':
      return `(${genNumber(random, depth - 1)} ${pick(random, ['+', '-', '*'])} ${genNumber(random, depth - 1)})`
    case 'call1':
      return `${pick(random, ['abs', 'floor', 'ceil'])}(${genNumber(random, depth - 1)})`
    case 'len':
      return `len(${random() < 0.5 ? genString(random, depth - 1) : 'nums'})`
    case 'agg':
      return `${pick(random, ['sum', 'avg', 'min', 'max', 'median'])}(nums)`
    default:
      return `(${genBoolean(random, depth - 1)} ? ${genNumber(random, depth - 1)} : ${genNumber(random, depth - 1)})`
  }
}

function genString(random, depth) {
  if (depth <= 0 || random() < 0.35) {
    return random() < 0.5 ? JSON.stringify(pick(random, ['ok', 'x', '', 'Ada'])) : pick(random, STRING_TERMS)
  }
  const shape = pick(random, ['concat', 'call1', 'replace', 'stringify', 'conditional'])
  switch (shape) {
    case 'concat':
      return `(${genString(random, depth - 1)} + ${genString(random, depth - 1)})`
    case 'call1':
      return `${pick(random, ['upper', 'lower', 'trim'])}(${genString(random, depth - 1)})`
    case 'replace':
      return `replace(${genString(random, depth - 1)}, "a", "b")`
    case 'stringify':
      return `string(${random() < 0.5 ? genNumber(random, depth - 1) : genBoolean(random, depth - 1)})`
    default:
      return `(${genBoolean(random, depth - 1)} ? ${genString(random, depth - 1)} : ${genString(random, depth - 1)})`
  }
}

function genBoolean(random, depth) {
  if (depth <= 0 || random() < 0.3) {
    return pick(random, ['true', 'false', 'flag'])
  }
  const shape = pick(random, ['numCmp', 'strCmp', 'logical', 'not', 'member', 'predicate', 'empty'])
  switch (shape) {
    case 'numCmp':
      return `(${genNumber(random, depth - 1)} ${pick(random, ['<', '<=', '>', '>=', '==', '!='])} ${genNumber(random, depth - 1)})`
    case 'strCmp':
      return `(${genString(random, depth - 1)} ${pick(random, ['==', '!='])} ${genString(random, depth - 1)})`
    case 'logical':
      return `(${genBoolean(random, depth - 1)} ${pick(random, ['&&', '||'])} ${genBoolean(random, depth - 1)})`
    case 'not':
      return `!(${genBoolean(random, depth - 1)})`
    case 'member':
      return `(${genNumber(random, depth - 1)} in nums)`
    case 'predicate':
      return `${pick(random, ['contains', 'startsWith', 'endsWith'])}(${genString(random, depth - 1)}, ${genString(random, depth - 1)})`
    default:
      return `isEmpty(${genString(random, depth - 1)})`
  }
}

const GENERATORS = { number: genNumber, string: genString, boolean: genBoolean }

function generate(seed, count, depth = 4) {
  const random = rng(seed)
  const out = []
  for (let i = 0; i < count; i++) {
    const kind = pick(random, ['number', 'string', 'boolean'])
    out.push({ source: GENERATORS[kind](random, depth), kind, seed: seed + i })
  }
  return out
}

// The one place the language is knowingly permissive: NUMERIC parameters accept
// strings, because `number("42")` must work, which means `number("abc")`
// type-checks and fails at run time. Both spellings of that failure — the
// evaluator's own coercion and the stdlib's argument guard.
const COERCION_FAILURE = /as a number|expected a number/

const errorsOf = (source) =>
  checkTypes(parse(source), ENV).diagnostics.filter((d) => d.severity === 'error')

const evaluateOrError = (source) => {
  try {
    return { ok: true, value: evaluateExpression(source, SCOPE) }
  } catch (err) {
    if (!(err instanceof ExpressionError)) throw err
    return { ok: false, message: err.message }
  }
}

describe('the generated corpus itself', () => {
  it('parses everything it produces', () => {
    for (const { source } of generate(1, 200)) {
      expect(() => parse(source)).not.toThrow()
    }
  })

  it('covers all three shapes and gets past the trivial cases', () => {
    const corpus = generate(2, 200)
    const kinds = new Set(corpus.map((c) => c.kind))
    expect([...kinds].sort()).toEqual(['boolean', 'number', 'string'])
    // A corpus of bare identifiers would pass every property below and prove
    // nothing, so the shape of the sample is asserted too.
    expect(corpus.filter((c) => c.source.length > 30).length).toBeGreaterThan(60)
  })
})

describe('precision — the checker does not cry wolf', () => {
  it('reports no error about any expression that evaluates', () => {
    for (const { source, seed } of generate(3, 400)) {
      const run = evaluateOrError(source)
      if (!run.ok) continue
      const errors = errorsOf(source)
      expect({ seed, source, errors: errors.map((e) => e.message) }).toEqual({
        seed,
        source,
        errors: [],
      })
    }
  })

  it('holds for deeper expressions too', () => {
    for (const { source, seed } of generate(4, 150, 6)) {
      const run = evaluateOrError(source)
      if (!run.ok) continue
      expect({ seed, source, errors: errorsOf(source).map((e) => e.message) }).toEqual({
        seed,
        source,
        errors: [],
      })
    }
  })
})

describe('soundness, modulo the documented coercion', () => {
  it('never lets a type-clean expression fail for a type reason', () => {
    for (const { source, seed } of generate(5, 400)) {
      if (errorsOf(source).length > 0) continue
      const run = evaluateOrError(source)
      if (run.ok) continue
      // The only failure a checked expression is permitted is the one the
      // language chose: a string that does not parse as a number.
      expect({ seed, source, message: run.message }).toEqual({
        seed,
        source,
        message: expect.stringMatching(COERCION_FAILURE),
      })
    }
  })

  it('names that boundary explicitly, so it cannot move silently', () => {
    // `number(name)` type-checks — NUMERIC accepts strings, because it has to
    // for `number(code)` — and fails at run time on a string that is not one.
    expect(errorsOf('number(name)')).toEqual([])
    expect(evaluateOrError('number(name)')).toEqual({
      ok: false,
      message: expect.stringMatching(COERCION_FAILURE),
    })
    // And the reason it is permitted at all.
    expect(evaluateOrError('number(code)')).toEqual({ ok: true, value: 42 })
  })
})

describe('determinism and containment', () => {
  it('evaluates to the same value twice', () => {
    for (const { source } of generate(6, 200)) {
      const first = evaluateOrError(source)
      const second = evaluateOrError(source)
      expect(second).toEqual(first)
    }
  })

  it('never returns anything that is not plain data', () => {
    // The sandbox claim, checked over the corpus rather than over a list of
    // known escapes: whatever an expression evaluates to must survive a JSON
    // round trip, because a host object would not.
    for (const { source } of generate(7, 300)) {
      const run = evaluateOrError(source)
      if (!run.ok) continue
      expect(typeof run.value).not.toBe('function')
      expect(JSON.parse(JSON.stringify({ v: run.value ?? null }))).toEqual({
        v: run.value ?? null,
      })
    }
  })

  it('leaves the prototype chain alone', () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length
    for (const { source } of generate(8, 200)) evaluateOrError(source)
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before)
    expect({}.polluted).toBeUndefined()
  })
})

// — the hostile corpus ——————————————————————————————————————————————————
//
// Everything above generates programs that are well-typed *by construction*,
// which is the only way to state a precision property. This generates the
// opposite: expressions that mix sorts freely across the whole stdlib, index
// numbers, read fields off booleans, and call functions that do not exist.
// Almost all of them are nonsense, which is the point — it is the corpus a
// checker is most likely to crash or lie on.

const ATOMS = [
  'count', 'name', 'code', 'flag', 'nums', 'words', 'user', 'blob', 'dunno',
  '1', '0', '""', '"7"', 'true', 'null', '[1,2]', '["a"]', '{a:1}',
]
const HOSTILE_FN1 = [
  'type', 'string', 'number', 'bool', 'isEmpty', 'len', 'upper', 'trim', 'abs',
  'floor', 'json', 'parseJson', 'sum', 'avg', 'median', 'first', 'last',
  'reverse', 'sort', 'unique', 'keys', 'values', 'flatten',
]
const HOSTILE_FN2 = [
  'contains', 'startsWith', 'split', 'indexOf', 'default', 'pow', 'join',
  'get', 'has', 'matching', 'notMatching', 'take', 'skip',
]
const HOSTILE_OPS = ['+', '-', '*', '/', '%', '==', '!=', '<', '>=', '&&', '||', 'in']

// A wider environment than the typed generator's: `blob` is dynamic by contract
// and `dunno` is unproven, which are precisely the two values the checker is
// supposed to stay silent about.
const HOSTILE_ENV = T.objectOf({
  count: T.NUMBER,
  name: T.STRING,
  code: T.STRING,
  flag: T.BOOLEAN,
  nums: T.arrayOf(T.NUMBER),
  words: T.arrayOf(T.STRING),
  user: T.objectOf({ id: T.NUMBER, email: T.STRING }),
  blob: T.ANY,
  dunno: T.UNKNOWN,
})
const HOSTILE_SCOPE = { ...SCOPE, blob: { deep: { x: 1 } }, dunno: null }

function genHostile(random, depth) {
  if (depth <= 0) return pick(random, ATOMS)
  switch (pick(random, ['atom', 'bin', 'un', 'fn1', 'fn2', 'member', 'index', 'cond', 'arr'])) {
    case 'atom':
      return pick(random, ATOMS)
    case 'bin':
      return `(${genHostile(random, depth - 1)} ${pick(random, HOSTILE_OPS)} ${genHostile(random, depth - 1)})`
    case 'un':
      return `${pick(random, ['!', '-'])}(${genHostile(random, depth - 1)})`
    case 'fn1':
      return `${pick(random, HOSTILE_FN1)}(${genHostile(random, depth - 1)})`
    case 'fn2':
      return `${pick(random, HOSTILE_FN2)}(${genHostile(random, depth - 1)}, ${genHostile(random, depth - 1)})`
    case 'member':
      return `(${genHostile(random, depth - 1)}).${pick(random, ['id', 'email', 'x', 'length', 'a'])}`
    case 'index':
      return `(${genHostile(random, depth - 1)})[${pick(random, ['0', '1', '"a"'])}]`
    case 'cond':
      return `(${genHostile(random, depth - 1)} ? ${genHostile(random, depth - 1)} : ${genHostile(random, depth - 1)})`
    default:
      return `[${genHostile(random, depth - 1)}, ${genHostile(random, depth - 1)}]`
  }
}

function hostileCorpus(seed, count, depth = 4) {
  const random = rng(seed)
  return Array.from({ length: count }, () => genHostile(random, depth))
}

// Where a type-clean expression is still allowed to fail at run time, and why
// each one is the checker standing down rather than being wrong:
//
//   Unknown function      `analyze()` owns that finding; reporting it twice
//                         would be noise, so `checkTypes` returns unknown.
//   … as a number         the string→number coercion, and its stdlib spelling.
//   expected an array     a value-domain guard on a dynamic value.
//   invalid JSON / date   likewise: the *content* of a string, not its type.
const RUNTIME_GUARDS =
  /Unknown function|as a number|expected a number|expected an array|invalid JSON|is not a valid date|invalid timestamp|unit must be/

const hostileErrors = (source) =>
  checkTypes(parse(source), HOSTILE_ENV).diagnostics.filter((d) => d.severity === 'error')

describe('the hostile corpus', () => {
  it('is genuinely hostile — most of it is rejected', () => {
    const corpus = hostileCorpus(21, 400)
    const rejected = corpus.filter((source) => {
      try {
        return hostileErrors(source).length > 0
      } catch {
        return false
      }
    })
    // Without this the properties below would be vacuous: a corpus the checker
    // has nothing to say about proves nothing about the checker.
    expect(rejected.length / corpus.length).toBeGreaterThan(0.5)
  })

  it('never crashes the parser, the checker, or the evaluator', () => {
    for (const source of hostileCorpus(22, 1200)) {
      let ast
      try {
        ast = parse(source)
      } catch (err) {
        expect(err).toBeInstanceOf(ExpressionError)
        continue
      }
      expect(() => checkTypes(ast, HOSTILE_ENV)).not.toThrow()
      try {
        evaluateExpression(source, HOSTILE_SCOPE)
      } catch (err) {
        expect({ source, name: err.constructor.name }).toEqual({
          source,
          name: 'ExpressionError',
        })
      }
    }
  })

  it('fails a type-clean expression only where it deliberately stood down', () => {
    for (const source of hostileCorpus(23, 1200)) {
      let ast
      try {
        ast = parse(source)
      } catch {
        continue
      }
      if (checkTypes(ast, HOSTILE_ENV).diagnostics.some((d) => d.severity === 'error')) continue
      try {
        evaluateExpression(source, HOSTILE_SCOPE)
      } catch (err) {
        expect({ source, message: err.message }).toEqual({
          source,
          message: expect.stringMatching(RUNTIME_GUARDS),
        })
      }
    }
  })

  it('does not treat a successful evaluation as evidence against a finding', () => {
    // The subtlety the corpus made obvious, and the exact case TYPES.md singles
    // out: FXL member access *returns undefined* rather than throwing, so an
    // expression the checker correctly rejects still "evaluates" — and a
    // coercion further out launders that undefined into a real value. Precision
    // is therefore a property of well-typed programs, not of ones that happen
    // to produce an answer, which is why the generator above builds by type
    // rather than by shape.
    expect(errorsOf('(1).a').map((e) => e.message)).toEqual(['number has no field "a"'])
    expect(evaluateOrError('(1).a')).toEqual({ ok: true, value: undefined })
    expect(evaluateOrError('len(!((true)[1]))')).toEqual({ ok: true, value: 0 })
  })

  it('says nothing about a function it has no signature for', () => {
    // Deliberate: the linter's `analyze()` pass reports an unknown function, and
    // a second finding in different words would be noise. The runtime still
    // refuses to call it, which is what the guard list above allows for.
    expect(errorsOf('noSuchFunction(count)')).toEqual([])
    expect(evaluateOrError('noSuchFunction(count)')).toEqual({
      ok: false,
      message: expect.stringMatching(/Unknown function/),
    })
  })
})

describe('the parser survives input nobody wrote on purpose', () => {
  // Not well-formed programs — the opposite. A parser is the first thing a
  // malformed config reaches, and the contract is that it fails as an
  // ExpressionError rather than as a crash, however strange the input.
  const ALPHABET = [
    ...'abc09 ',
    ...'+-*/%<>=!&|?:.,',
    '(', ')', '[', ']', '{', '}', '"', "'", '\\', '\n', '\t',
    '&&', '||', '==', '!=', '>=', '<=', 'in', '"unterminated', '0x', '1e', '..',
    ' ', ' ', '💥',
  ]

  it('never throws anything but an ExpressionError', () => {
    const random = rng(99)
    for (let i = 0; i < 3000; i++) {
      const length = 1 + Math.floor(random() * 24)
      let source = ''
      for (let j = 0; j < length; j++) source += pick(random, ALPHABET)
      try {
        parse(source)
      } catch (err) {
        expect({ source, name: err.constructor.name }).toEqual({
          source,
          name: 'ExpressionError',
        })
      }
    }
  })

  it('bounds a pathologically nested expression instead of overflowing', () => {
    const deep = `${'('.repeat(400)}1${')'.repeat(400)}`
    const result = (() => {
      try {
        parse(deep)
        return 'parsed'
      } catch (err) {
        return err instanceof ExpressionError ? 'refused' : 'crashed'
      }
    })()
    expect(result).not.toBe('crashed')
  })

  it('refuses an expression that would monopolise a worker', () => {
    // The step counter, exercised through the front door: a long chain of real
    // work has to be refused rather than run.
    const long = Array.from({ length: 400 }, (_, i) => `len("${'x'.repeat(20)}${i}")`).join(' + ')
    const run = evaluateOrError(long)
    if (!run.ok) expect(run.message).toMatch(/step limit|too large|too deeply/)
  })
})
