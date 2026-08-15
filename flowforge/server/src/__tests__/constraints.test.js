// The decision procedure behind path feasibility analysis, tested as an
// algorithm rather than through the feature that uses it — the same split
// dominance.test.js makes.
//
// Two properties carry every assertion here. **A satisfiable answer must come
// with a model that actually satisfies the constraints**, because the model is
// not a debugging aid: it becomes the trigger payload of a generated test
// scenario, so a wrong one produces a test that does not exercise the branch it
// claims to. And **`unsat` must be a fact, never a shrug** — anything the
// fragment cannot decide has to come back `unknown`, since a spurious `unsat`
// reports a live branch as dead.

const C = require('../services/constraints')

// Does `model` really satisfy `formula`? A tiny independent evaluator, written
// against the atom shapes rather than against the solver, so it cannot agree
// with the solver by sharing its bug.
function holds(formula, model) {
  switch (formula.op) {
    case 'true':
      return true
    case 'false':
      return false
    case 'not':
      return !holds(formula.arg, model)
    case 'and':
      return formula.args.every((a) => holds(a, model))
    case 'or':
      return formula.args.some((a) => holds(a, model))
    default:
      return atomHolds(formula.atom, model)
  }
}

function atomHolds(a, model) {
  const compare = (lhs, rel, rhs) => {
    switch (rel) {
      case '<': return lhs < rhs
      case '<=': return lhs <= rhs
      case '>': return lhs > rhs
      default: return lhs >= rhs
    }
  }
  const same = (x, y) => {
    if (x === null || y === null) return x === null && y === null
    if (typeof x === 'boolean' && typeof y === 'boolean') return x === y
    return String(x) === String(y)
  }
  switch (a.t) {
    case 'num':
      return compare(model[a.x], a.rel, a.c)
    case 'diff':
      return compare(model[a.x] - model[a.y], a.rel, a.c)
    case 'val':
      return a.rel === 'eq' ? same(model[a.x], a.v) : !same(model[a.x], a.v)
    case 'dom':
      return a.rel === 'in'
        ? a.vs.some((v) => same(model[a.x], v))
        : !a.vs.some((v) => same(model[a.x], v))
    default:
      // A free proposition constrains nothing a model can check.
      return true
  }
}

// Checked against the negation normal form, so a free proposition is judged
// only where it appears positively — a model has nothing to say about one, and
// `¬free` would otherwise read as false rather than as unconstrained.
const expectSat = (formula) => {
  const result = C.solve(formula)
  expect(result.status).toBe('sat')
  expect(holds(C.nnf(formula), result.model)).toBe(true)
  return result.model
}

const expectUnsat = (formula) => {
  expect(C.solve(formula).status).toBe('unsat')
}

describe('numeric constraints (difference logic)', () => {
  it('satisfies a single lower bound and reports a value above it', () => {
    const model = expectSat(C.num('amount', '>', 1000))
    expect(model.amount).toBeGreaterThan(1000)
  })

  it('refuses a bound that contradicts an earlier one', () => {
    expectUnsat(C.and([C.num('amount', '>', 1000), C.num('amount', '<', 100)]))
  })

  it('pins a variable that is bounded from both sides at the same point', () => {
    const model = expectSat(C.numEq('status', 200))
    expect(model.status).toBe(200)
  })

  it('separates a strict bound from a non-strict one at the same constant', () => {
    // x ≤ 5 and x > 5 have no solution; x ≤ 5 and x ≥ 5 have exactly one.
    expectUnsat(C.and([C.num('x', '<=', 5), C.num('x', '>', 5)]))
    expect(expectSat(C.and([C.num('x', '<=', 5), C.num('x', '>=', 5)])).x).toBe(5)
  })

  it('finds a value strictly between two adjacent integers', () => {
    const model = expectSat(C.and([C.num('x', '>', 4), C.num('x', '<', 5)]))
    expect(model.x).toBeGreaterThan(4)
    expect(model.x).toBeLessThan(5)
  })

  it('decides constraints between two variables', () => {
    const model = expectSat(C.and([C.diff('a', 'b', '>=', 10), C.num('b', '>=', 0)]))
    expect(model.a - model.b).toBeGreaterThanOrEqual(10)
    // A cycle of strict differences is the negative cycle the algorithm exists
    // to find: a < b and b < a.
    expectUnsat(C.and([C.diff('a', 'b', '<', 0), C.diff('b', 'a', '<', 0)]))
  })

  it('handles disequality by splitting it into two half-planes', () => {
    const model = expectSat(C.and([C.numNe('x', 7), C.num('x', '>=', 7), C.num('x', '<=', 9)]))
    expect(model.x).not.toBe(7)
    expectUnsat(C.and([C.numNe('x', 7), C.numEq('x', 7)]))
  })

  it('prefers a whole number when one satisfies the constraints', () => {
    // The model is read by a person — it becomes a generated scenario's trigger
    // payload — so `1000 + ε` is a correct answer and a bad one.
    expect(expectSat(C.num('amount', '>', 1000)).amount).toBe(1001)
    expect(expectSat(C.num('amount', '>=', 3)).amount).toBe(3)
    expect(Number.isInteger(expectSat(C.and([C.num('x', '>', 2), C.num('x', '<', 10)])).x)).toBe(true)
  })
})

describe('value constraints (finite domains)', () => {
  it('contradicts an equality with its own negation', () => {
    expectUnsat(C.and([C.val('status', 'eq', 'open'), C.val('status', 'ne', 'open')]))
  })

  it('picks a domain member that no disequality excludes', () => {
    const model = expectSat(C.and([C.dom('s', 'in', ['a', 'b']), C.val('s', 'ne', 'a')]))
    expect(model.s).toBe('b')
  })

  it('refuses two memberships with nothing in common', () => {
    expectUnsat(C.and([C.dom('s', 'in', ['a']), C.dom('s', 'in', ['b'])]))
  })

  it('refuses a domain whose every member is banned', () => {
    expectUnsat(
      C.and([C.dom('s', 'in', ['a', 'b']), C.val('s', 'ne', 'a'), C.val('s', 'ne', 'b')])
    )
  })

  it('invents a value when only disequalities constrain it', () => {
    const model = expectSat(C.and([C.val('s', 'ne', 'ok'), C.val('s', 'ne', 'other')]))
    expect(model.s).not.toBe('ok')
    expect(model.s).not.toBe('other')
  })

  it('compares values the way FXL does, not the way JavaScript does', () => {
    // looseEquals says true == "true", so requiring both is a contradiction —
    // and treating them as different values would hide it.
    expectUnsat(C.and([C.val('flag', 'eq', true), C.val('flag', 'ne', 'true')]))
    expectUnsat(C.and([C.val('n', 'eq', 0), C.val('n', 'ne', '0')]))
  })

  it('reconciles truthiness with equality through the same domain machinery', () => {
    expectUnsat(C.and([C.truthy('flag'), C.falsy('flag')]))
    expect(expectSat(C.truthy('flag')).flag).toBeTruthy()
    // An empty string is the one string FXL treats as falsy.
    expectUnsat(C.and([C.truthy('name'), C.val('name', 'eq', '')]))
    expectSat(C.and([C.truthy('name'), C.val('name', 'eq', 'x')]))
  })
})

describe('free propositions', () => {
  it('constrains nothing on its own', () => {
    expectSat(C.free('validate-1:valid'))
  })

  it('cannot hold and fail at once — which is what separates a gate’s outcomes', () => {
    expectUnsat(C.and([C.free('validate-1'), C.not(C.free('validate-1'))]))
  })

  it('keeps distinct propositions independent', () => {
    expectSat(C.and([C.free('a'), C.not(C.free('b'))]))
  })
})

describe('boolean structure', () => {
  it('takes the satisfiable side of a disjunction', () => {
    const model = expectSat(
      C.and([C.or([C.num('x', '>', 10), C.val('s', 'eq', 'a')]), C.num('x', '<', 5)])
    )
    expect(model.s).toBe('a')
    expect(model.x).toBeLessThan(5)
  })

  it('pushes negation down to the atoms', () => {
    // ¬(x > 5 ∧ x < 10) is x ≤ 5 ∨ x ≥ 10 — satisfiable, and with x = 12 the
    // second conjunct forces the right half.
    const model = expectSat(
      C.and([C.not(C.and([C.num('x', '>', 5), C.num('x', '<', 10)])), C.num('x', '>', 11)])
    )
    expect(model.x).toBeGreaterThanOrEqual(10)
  })

  it('refuses a disjunction whose every branch contradicts the context', () => {
    expectUnsat(
      C.and([
        C.or([C.num('x', '>', 100), C.num('x', '<', 0)]),
        C.num('x', '>=', 0),
        C.num('x', '<=', 100),
      ])
    )
  })

  it('decides the shape a switch node produces — the negation of every case', () => {
    // default = ¬(kind == "a") ∧ ¬(kind == "b"), reachable; but not alongside
    // a case that already matched.
    const caseA = C.val('kind', 'eq', 'a')
    const caseB = C.val('kind', 'eq', 'b')
    const fallthrough = C.and([C.not(caseA), C.not(caseB)])
    expectSat(fallthrough)
    expectUnsat(C.and([fallthrough, caseA]))
  })
})

describe('honesty about what it cannot decide', () => {
  it('reports unknown rather than unsat when a variable is used as two sorts', () => {
    const result = C.solve(C.and([C.num('x', '>', 5), C.val('x', 'eq', 'open')]))
    expect(result.status).toBe('unknown')
    expect(result.model).toBeNull()
  })

  it('does not let an undecidable branch turn a satisfiable one into unsat', () => {
    const result = C.solve(
      C.or([C.and([C.num('x', '>', 5), C.val('x', 'eq', 'open')]), C.val('s', 'eq', 'a')])
    )
    expect(result.status).toBe('sat')
    expect(result.model.s).toBe('a')
  })

  it('reports unknown when only undecidable branches remain', () => {
    expect(
      C.solve(C.or([C.and([C.num('x', '>', 5), C.val('x', 'eq', 'a')])])).status
    ).toBe('unknown')
  })

  it('is satisfiable with no constraints at all', () => {
    expect(C.solve(C.TRUE).status).toBe('sat')
    expect(C.solve(C.and([])).status).toBe('sat')
    expect(C.solve(C.FALSE).status).toBe('unsat')
  })
})

describe('pruning', () => {
  it('survives the exponential shape a many-case switch produces', () => {
    // The `default` branch of an n-case switch is the conjunction of n
    // negations, each of which is itself a disjunction — 2ⁿ cubes if they were
    // enumerated. Checking the theory after each literal collapses it.
    const cases = Array.from({ length: 16 }, (_, i) =>
      C.and([C.num('x', '>=', i * 10), C.num('x', '<', i * 10 + 10)])
    )
    const fallthrough = C.and(cases.map((c) => C.not(c)))
    const model = expectSat(C.and([fallthrough, C.num('x', '>=', 0)]))
    expect(model.x).toBeGreaterThanOrEqual(160)
  })
})
