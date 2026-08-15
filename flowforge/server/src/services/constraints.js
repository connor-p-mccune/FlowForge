// A small decision procedure — the solver behind path feasibility analysis
// (services/pathConstraints.js). Nothing here knows what a workflow is: it
// decides whether a boolean combination of arithmetic and equality constraints
// can be satisfied at once, and if so produces values that satisfy them. That
// separation is deliberate, and it is the same one dominance.js makes — the
// algorithm is testable as an algorithm rather than only through the feature
// that uses it.
//
// The question it answers is the one nothing else in the product could:
//
//     is there any input that takes this path?
//
// Every other static check here reasons about the *graph*. The linter asks
// whether a node's config is complete, the type checker what shape a value has,
// lineage where it came from, guarantees which paths exist. All four are silent
// about the branch guarded by `amount > 1000` that sits downstream of a branch
// guarded by `amount < 100` — a path that exists in the graph and that no run
// will ever take.
//
// ## The fragment, and why it stops where it does
//
// Deciding arbitrary constraints is undecidable, so the only honest design is
// to pick a fragment with a decision procedure and be explicit about the edge:
//
//   * **Difference logic** over the numbers — `x ≤ c`, `x > c`, `x - y ≤ c`.
//     Satisfiability is negative-cycle detection in a constraint graph, which
//     is Bellman-Ford, and the shortest-path distances *are* a model. Both
//     halves of what this module needs fall out of one classical algorithm.
//   * **Finite domains** over everything else — `x == "open"`,
//     `x in ["a","b"]`, `x != null`. Intersection and subtraction of sets.
//   * **Free booleans** for anything outside both: a schema check, a human
//     approval, whether a call failed. They constrain nothing on their own, but
//     two *opposite* uses of the same one cannot both hold — which is exactly
//     what makes a validate node's `valid` and `invalid` outcomes mutually
//     exclusive without the solver knowing what JSON Schema is.
//
// Anything the extraction layer cannot express in that fragment arrives as a
// free boolean, so the solver's answer degrades to "satisfiable" rather than to
// a wrong "no". **Every approximation here is on the satisfiable side**, and
// that direction is the whole safety argument: a spurious *sat* costs a missing
// finding, a spurious *unsat* would report a live branch as dead and send
// somebody to "fix" a correct workflow.
//
// ## The search
//
// A DPLL(T)-shaped search rather than a full CNF conversion: the formula is put
// in negation normal form and flattened, then explored depth-first, extending a
// conjunction one literal at a time and asking the theory solver after each
// extension. A conflicting partial assignment is abandoned immediately instead
// of being carried to a complete one, which is what keeps a nine-case switch
// (whose `default` guard is the negation of every case) from expanding into 2⁹
// cubes. The search is bounded; exhausting the budget returns `unknown`, never
// a guess.

// ε, the infinitesimal that separates `x < 5` from `x ≤ 5`. Weights are carried
// as [constant, epsilonCount] pairs and compared lexicographically, so the
// strictness survives the arithmetic exactly rather than approximately; this
// value is only used when a model is finally rendered as a number. A power of
// two so the rendered value stays exact in binary floating point.
const EPSILON = 1 / 1024

// How many theory checks one `solve` may perform. A path condition from a real
// canvas settles in tens; a pathological one that would spend a minute in here
// is reported as `unknown`, because a linter that hangs is a linter somebody
// turns off.
const MAX_THEORY_CHECKS = 20000

// The values FXL's `toBool` treats as false (functions.js): a string is falsy
// only when empty, everything else follows `Boolean`. A `falsy(x)` atom is
// therefore a finite-domain constraint, which is why the boolean theory below
// is a special case of the value theory rather than a third one.
const FALSY_VALUES = [false, null, 0, '']

// — formulas ————————————————————————————————————————————————————————————
//
// Plain JSON objects, like the FXL AST and the type lattice, so a formula can
// be logged, cached, or shipped to a client without a serialiser.

const TRUE = { op: 'true' }
const FALSE = { op: 'false' }

const atom = (a) => ({ op: 'atom', atom: a })
const not = (arg) => ({ op: 'not', arg })

function and(args) {
  const flat = []
  for (const a of args) {
    if (!a || a.op === 'true') continue
    if (a.op === 'false') return FALSE
    if (a.op === 'and') flat.push(...a.args)
    else flat.push(a)
  }
  if (flat.length === 0) return TRUE
  if (flat.length === 1) return flat[0]
  return { op: 'and', args: flat }
}

function or(args) {
  const flat = []
  for (const a of args) {
    if (!a || a.op === 'false') continue
    if (a.op === 'true') return TRUE
    if (a.op === 'or') flat.push(...a.args)
    else flat.push(a)
  }
  if (flat.length === 0) return FALSE
  if (flat.length === 1) return flat[0]
  return { op: 'or', args: flat }
}

// — atoms ———————————————————————————————————————————————————————————————
//
// Five shapes, each belonging to exactly one theory below.
//
//   { t: 'num',  x, rel, c }        x rel c              (rel: < <= > >=)
//   { t: 'diff', x, y, rel, c }     x - y rel c
//   { t: 'val',  x, rel, v }        x == v | x != v      (v is not a number)
//   { t: 'dom',  x, rel, vs }       x in vs | x not in vs
//   { t: 'free', id, neg }          an opaque proposition
//
// Numeric *equality* is deliberately not an atom: `x == c` is two inequalities
// and `x != c` is a disjunction of two, so expressing them at the formula level
// keeps every numeric atom a half-plane — which is precisely the shape
// difference logic decides.

const num = (x, rel, c) => atom({ t: 'num', x, rel, c })
const diff = (x, y, rel, c) => atom({ t: 'diff', x, y, rel, c })
const val = (x, rel, v) => atom({ t: 'val', x, rel, v })
const dom = (x, rel, vs) => atom({ t: 'dom', x, rel, vs })
const free = (id) => atom({ t: 'free', id, neg: false })

const numEq = (x, c) => and([num(x, '<=', c), num(x, '>=', c)])
const numNe = (x, c) => or([num(x, '<', c), num(x, '>', c)])

// `x` used where a boolean is wanted. Modelled as a domain constraint so a
// variable can be both compared and tested for truthiness without a third
// theory having to agree with the other two.
const truthy = (x) => dom(x, 'nin', FALSY_VALUES)
const falsy = (x) => dom(x, 'in', FALSY_VALUES)

function negateAtom(a) {
  switch (a.t) {
    case 'num':
      return { ...a, rel: { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[a.rel] }
    case 'diff':
      return { ...a, rel: { '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[a.rel] }
    case 'val':
      return { ...a, rel: a.rel === 'eq' ? 'ne' : 'eq' }
    case 'dom':
      return { ...a, rel: a.rel === 'in' ? 'nin' : 'in' }
    default:
      return { ...a, neg: !a.neg }
  }
}

// Negation normal form: `not` is pushed down to the atoms, so the search below
// only ever sees and / or / atom and never has to reason about polarity.
function nnf(formula, negated = false) {
  if (!formula) return negated ? FALSE : TRUE
  switch (formula.op) {
    case 'true':
      return negated ? FALSE : TRUE
    case 'false':
      return negated ? TRUE : FALSE
    case 'not':
      return nnf(formula.arg, !negated)
    case 'and':
      return negated
        ? or(formula.args.map((a) => nnf(a, true)))
        : and(formula.args.map((a) => nnf(a, false)))
    case 'or':
      return negated
        ? and(formula.args.map((a) => nnf(a, true)))
        : or(formula.args.map((a) => nnf(a, false)))
    default:
      return atom(negated ? negateAtom(formula.atom) : formula.atom)
  }
}

// — weights ——————————————————————————————————————————————————————————————
//
// [constant, epsilons]. `x < 5` is the edge weight 5 − ε, and comparing
// lexicographically makes the strictness exact: 5 − ε really is smaller than 5,
// and adding two strict bounds really does accumulate two ε.

const W = (c, e = 0) => [c, e]
const wAdd = (a, b) => [a[0] + b[0], a[1] + b[1]]
const wLess = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const wNumber = (w) => w[0] + w[1] * EPSILON

// — the numeric theory ————————————————————————————————————————————————————
//
// Difference logic. Every atom becomes an edge `v → u` of weight `w` meaning
// `u − v ≤ w`, with a distinguished ZERO node standing in for the constant 0 —
// which is what lets a bound on a single variable (`x ≤ 5`) and a bound on a
// difference (`x − y ≤ 5`) be the same kind of edge and share one algorithm.
//
// The conjunction is satisfiable iff the graph has no negative cycle (a cycle
// summing below zero says some quantity is strictly less than itself), and the
// shortest-path distances from a virtual source are a satisfying assignment.
// Bellman-Ford therefore answers both questions in one pass, which is the
// reason this fragment was chosen over general linear arithmetic.
const ZERO = ' zero'

function numericEdges(atoms) {
  const edges = []
  for (const a of atoms) {
    if (a.t === 'num') {
      const strict = a.rel === '<' || a.rel === '>' ? -1 : 0
      // x ≤ c  ⇒  x − ZERO ≤ c        x ≥ c  ⇒  ZERO − x ≤ −c
      if (a.rel === '<' || a.rel === '<=') edges.push([ZERO, a.x, W(a.c, strict)])
      else edges.push([a.x, ZERO, W(-a.c, strict)])
    } else if (a.t === 'diff') {
      const strict = a.rel === '<' || a.rel === '>' ? -1 : 0
      if (a.rel === '<' || a.rel === '<=') edges.push([a.y, a.x, W(a.c, strict)])
      else edges.push([a.x, a.y, W(-a.c, strict)])
    }
  }
  return edges
}

// Shortest paths from a virtual source joined to every node at weight 0, so the
// result covers nodes ZERO cannot reach. Returns null on a negative cycle.
function bellmanFord(nodes, edges) {
  const dist = new Map(nodes.map((n) => [n, W(0)]))
  for (let round = 0; round < nodes.length; round++) {
    let changed = false
    for (const [from, to, w] of edges) {
      const candidate = wAdd(dist.get(from), w)
      if (wLess(candidate, dist.get(to))) {
        dist.set(to, candidate)
        changed = true
      }
    }
    if (!changed) return dist
  }
  // One more relaxation still improves something: a cycle of negative total
  // weight, i.e. a chain of constraints demanding x < x.
  for (const [from, to, w] of edges) {
    if (wLess(wAdd(dist.get(from), w), dist.get(to))) return null
  }
  return dist
}

// Does a concrete number satisfy every numeric atom about `x`, given the values
// chosen for the other variables? Used only to prettify a model — the solver's
// verdict never depends on it.
function satisfiesNumeric(atoms, x, value, values) {
  const holds = (lhs, rel, rhs) => {
    switch (rel) {
      case '<': return lhs < rhs
      case '<=': return lhs <= rhs
      case '>': return lhs > rhs
      default: return lhs >= rhs
    }
  }
  for (const a of atoms) {
    if (a.t === 'num' && a.x === x && !holds(value, a.rel, a.c)) return false
    if (a.t === 'diff') {
      if (a.x === x && !holds(value - values[a.y], a.rel, a.c)) return false
      if (a.y === x && !holds(values[a.x] - value, a.rel, a.c)) return false
    }
  }
  return true
}

// A model is for a person to read — it becomes the trigger payload of a
// generated test scenario — so 1000.0009765625 is a bad answer to "what amount
// takes this branch?" even though it is a correct one. Each variable is offered
// its rounded neighbours and keeps the first that still satisfies everything.
function prettify(atoms, values) {
  for (const x of Object.keys(values)) {
    const v = values[x]
    if (!Number.isFinite(v) || Number.isInteger(v)) continue
    for (const candidate of [Math.round(v), Math.ceil(v), Math.floor(v)]) {
      if (satisfiesNumeric(atoms, x, candidate, values)) {
        values[x] = candidate
        break
      }
    }
  }
  return values
}

function solveNumeric(atoms) {
  const relevant = atoms.filter((a) => a.t === 'num' || a.t === 'diff')
  if (relevant.length === 0) return { ok: true, values: {} }

  const nodes = new Set([ZERO])
  for (const a of relevant) {
    nodes.add(a.x)
    if (a.t === 'diff') nodes.add(a.y)
  }
  const dist = bellmanFord([...nodes], numericEdges(relevant))
  if (!dist) return { ok: false }

  // Shifting every distance by dist(ZERO) preserves the differences the
  // constraints are about and pins the origin where the constants assume it.
  const origin = dist.get(ZERO)
  const values = {}
  for (const n of nodes) {
    if (n === ZERO) continue
    values[n] = wNumber([dist.get(n)[0] - origin[0], dist.get(n)[1] - origin[1]])
  }
  return { ok: true, values: prettify(relevant, values) }
}

// — the value theory ——————————————————————————————————————————————————————
//
// Equality and membership over anything that is not a number. Each variable
// accumulates what it must be, what it may be, and what it may not be; the
// conjunction is unsatisfiable exactly when those cannot be reconciled.

// Value equality as FXL defines it (`functions.js`, `looseEquals`), restricted
// to the scalars this theory holds: null equals only null, two booleans compare
// directly, and everything else compares by string form — so `true == "true"`
// and `0 == "0"` here for the same reason they do at run time. Mirroring the
// evaluator matters more than being strict: treating them as different values
// would make a satisfiable conjunction look contradictory, which is the one
// error direction this module refuses to make.
function sameValue(a, b) {
  if (a === null || b === null) return a === null && b === null
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b
  return String(a) === String(b)
}

function solveValues(atoms) {
  const state = new Map() // x -> { must, domain: array|null, banned: [] }
  const of = (x) => {
    if (!state.has(x)) state.set(x, { must: undefined, hasMust: false, domain: null, banned: [] })
    return state.get(x)
  }

  for (const a of atoms) {
    if (a.t === 'val') {
      const s = of(a.x)
      if (a.rel === 'eq') {
        if (s.hasMust && !sameValue(s.must, a.v)) return { ok: false }
        s.must = a.v
        s.hasMust = true
      } else {
        s.banned.push(a.v)
      }
    } else if (a.t === 'dom') {
      const s = of(a.x)
      if (a.rel === 'in') {
        s.domain = s.domain === null
          ? [...a.vs]
          : s.domain.filter((v) => a.vs.some((w) => sameValue(v, w)))
      } else {
        s.banned.push(...a.vs)
      }
    }
  }

  const values = {}
  for (const [x, s] of state) {
    const banned = (v) => s.banned.some((b) => sameValue(b, v))
    if (s.hasMust) {
      if (banned(s.must)) return { ok: false }
      if (s.domain !== null && !s.domain.some((v) => sameValue(v, s.must))) return { ok: false }
      values[x] = s.must
      continue
    }
    if (s.domain !== null) {
      const index = s.domain.findIndex((v) => !banned(v))
      if (index === -1) return { ok: false }
      values[x] = s.domain[index]
      continue
    }
    // Only disequalities: any value outside the banned set will do. Preferring
    // a readable string over a generated one keeps the witness legible.
    const candidates = ['ok', 'other', 'value', true, false, null, 0, 1]
    let chosen = candidates.find((v) => !banned(v))
    if (chosen === undefined) {
      for (let i = 0; chosen === undefined && i < s.banned.length + 2; i++) {
        if (!banned(`v${i}`)) chosen = `v${i}`
      }
    }
    values[x] = chosen
  }
  return { ok: true, values }
}

// — the theory combination ————————————————————————————————————————————————
//
// A variable constrained both numerically and by value has been asked to be two
// sorts at once. That is either a real bug the type checker already reports, or
// — far more likely — the extraction layer correlating two reads that are not
// the same value. Neither is worth a confident `unsat`, so the cube is reported
// `unknown` and the finding is simply not made. Silence over a maybe, exactly
// as the type checker resolves its own uncertainty.
function check(atoms) {
  const seenFree = new Map()
  const numericVars = new Set()
  const valueVars = new Set()

  for (const a of atoms) {
    if (a.t === 'free') {
      const previous = seenFree.get(a.id)
      if (previous !== undefined && previous !== a.neg) return { status: 'unsat' }
      seenFree.set(a.id, a.neg)
    } else if (a.t === 'num') {
      numericVars.add(a.x)
    } else if (a.t === 'diff') {
      numericVars.add(a.x)
      numericVars.add(a.y)
    } else {
      valueVars.add(a.x)
    }
  }

  for (const x of numericVars) {
    if (valueVars.has(x)) return { status: 'unknown' }
  }

  const numeric = solveNumeric(atoms)
  if (!numeric.ok) return { status: 'unsat' }
  const values = solveValues(atoms)
  if (!values.ok) return { status: 'unsat' }

  return { status: 'sat', model: { ...numeric.values, ...values.values } }
}

// — the search ————————————————————————————————————————————————————————————
//
// Depth-first over the formula's disjunctions, extending one conjunction and
// asking the theory after every literal. Checking eagerly rather than only at a
// complete assignment is what makes the negation of a many-case switch
// tractable: the first contradictory literal prunes the whole subtree instead
// of every one of its leaves being enumerated and rejected separately.
function solve(formula) {
  let checks = 0
  let exhausted = false

  function descend(pending, cube) {
    if (checks >= MAX_THEORY_CHECKS) {
      exhausted = true
      return null
    }
    if (pending.length === 0) {
      checks++
      const verdict = check(cube)
      if (verdict.status === 'sat') return verdict.model
      if (verdict.status === 'unknown') exhausted = true
      return null
    }

    const [head, ...rest] = pending
    switch (head.op) {
      case 'true':
        return descend(rest, cube)
      case 'false':
        return null
      case 'and':
        return descend([...head.args, ...rest], cube)
      case 'or': {
        for (const branch of head.args) {
          const found = descend([branch, ...rest], cube)
          if (found) return found
        }
        return null
      }
      default: {
        const extended = [...cube, head.atom]
        checks++
        const verdict = check(extended)
        if (verdict.status === 'unsat') return null
        if (verdict.status === 'unknown') {
          exhausted = true
          return null
        }
        return descend(rest, extended)
      }
    }
  }

  const model = descend([nnf(formula)], [])
  if (model) return { status: 'sat', model }
  // No branch satisfied the formula — but if any of them was abandoned because
  // the theory could not decide it or the budget ran out, "no" is not a fact.
  return { status: exhausted ? 'unknown' : 'unsat', model: null }
}

module.exports = {
  TRUE,
  FALSE,
  EPSILON,
  MAX_THEORY_CHECKS,
  FALSY_VALUES,
  and,
  or,
  not,
  atom,
  num,
  numEq,
  numNe,
  diff,
  val,
  dom,
  free,
  truthy,
  falsy,
  negateAtom,
  nnf,
  check,
  solve,
}
