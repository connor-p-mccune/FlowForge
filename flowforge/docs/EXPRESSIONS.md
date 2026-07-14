# FXL — the FlowForge expression language

FXL is a small, safe expression language you can use in two places on the
canvas:

- a **Condition** node's *matches expression…* operator — a boolean rule that
  routes the run down the true / false branch;
- a **Filter** node's *predicate* — a boolean rule evaluated once per list item
  to decide what to keep; and
- a **Map** node's *mapping* — an expression (usually an object literal)
  evaluated once per list item to build a new shape; and
- an **Aggregate** node's *value* and *group-by* — expressions evaluated per
  item to roll a list up to count / sum / avg / min / max, optionally grouped.

It exists so a single node can express real logic —
`amount > 1000 && status in ["pending", "review"]` — without FlowForge ever
running user input through `eval`, `new Function`, or `vm`. FXL is parsed to an
AST and walked by a tree evaluator that can only reach the values you give it
and the built-in functions below. See
[ARCHITECTURE.md → the expression language](./ARCHITECTURE.md#the-expression-language)
for how it's built and why.

> FXL is **not** a `{{…}}` template. A template *substitutes* a referenced
> value into a string; an FXL expression *computes* over live values. So you
> write bare names — `amount`, not `{{node.amount}}` — and the result keeps its
> real type (a number stays a number, a comparison yields a boolean).

---

## Trying an expression

Every FXL field on the canvas has a **Try this expression** panel: type sample
data as JSON and evaluate the field's expression against it, seeing the typed
result — or the syntax/runtime error — inline. It runs the same parser,
evaluator, and safety bounds the engine uses (`POST /api/expressions/evaluate`),
so a green result there is exactly what the node will compute. It's the fastest
way to check a rule before wiring it into a graph.

---

## Scope: what names are available

| Where | In scope |
|-------|----------|
| Condition expression | every field of the node's incoming data, plus `input` (the whole incoming object) |
| Filter predicate | every field of the current item (when it's an object), plus `item`, `index` (0-based), and `items` (the whole list) |
| Map mapping | same as the Filter predicate — each item's fields, plus `item`, `index`, `items` |
| Aggregate value / group-by | same per-item scope as Filter/Map |

```
# condition, incoming data { amount: 1500, status: "pending", user: { role: "admin" } }
amount > 1000 && status == "pending"          # true
input.user.role == "admin"                    # true

# filter over [{ price: 5, inStock: true }, { price: 40, inStock: false }]
price > 10                                     # keeps the second item
inStock && price < 100                         # keeps the first
index < 5                                      # keeps the first five, whatever they are
```

A name that isn't in scope evaluates to `null`/undefined rather than throwing —
so a rule against a missing field simply reads as empty.

---

## Types

Numbers (`42`, `3.14`, `1e3`), strings (`"hi"` or `'hi'`), booleans
(`true`/`false`), `null`, array literals (`[1, 2, 3]`), object literals
(`{ id: item.id, name: upper(name) }` — keys are an identifier or a string,
values any expression), and the objects/arrays that arrive in scope. String
escapes: `\n \t \r \\ \" \' \/`.

**Truthiness** (used by `!`, `&&`, `||`, `? :`, and both boolean sinks): falsy
values are `false`, `null`, `0`, `NaN`, and the empty string `""`. Everything
else — including `[]` and `{}` — is truthy. Use `isEmpty(x)` when you mean
"empty collection".

---

## Operators

From loosest to tightest binding:

| Precedence | Operators | Notes |
|-----------:|-----------|-------|
| 1 | `? :` | ternary, right-associative |
| 2 | `\|\|` / `or` | returns the first truthy operand (`x \|\| "default"`) |
| 3 | `&&` / `and` | returns the first falsy operand, else the last |
| 4 | `==` `!=` `===` `!==` `in` | equality & membership |
| 5 | `<` `<=` `>` `>=` | relational |
| 6 | `+` `-` | `+` concatenates when either side is a string |
| 7 | `*` `/` `%` | arithmetic |
| 8 | `!` / `not`, unary `-`, unary `+` | prefix |
| 9 | `a.b`, `a[i]`, `fn(x)` | member, index, call |

`and` / `or` / `not` are spellings of `&&` / `||` / `!`.

**Equality.** `==` is deterministic-loose: numbers compare numerically
(`5 == "5"` is true), objects/arrays compare by structure, `null` equals only
`null`, and everything else compares by string form. `===` is strict (no
coercion). **Relational** operators compare numerically when both sides are (or
look like) finite numbers, and lexically otherwise (`"10" > "3"` is true —
numeric, not alphabetical). **Arithmetic** (`- * / %`, and `+` on two numbers)
coerces numeric strings and booleans and throws a readable error on anything
non-numeric, so a typo fails loudly instead of silently becoming `NaN`.

**`in`** tests array membership (`x in [1, 2, 3]`), substring
(`"ell" in "hello"`), or object-key presence (`"name" in user`).

---

## Built-in functions

FXL has no methods on values — everything is a free function, and only the
names below are callable. Each validates its arguments and reports a readable
error on misuse. (The linter flags a call to any name not on this list before
you run.)

### Type & coalescing
| Function | Result |
|----------|--------|
| `type(v)` | `"null"`, `"array"`, `"object"`, `"string"`, `"number"`, or `"boolean"` |
| `string(v)` · `number(v)` · `bool(v)` | coerce to that type |
| `isEmpty(v)` | true for `null`, `""`, `[]`, `{}` |
| `default(v, fallback)` | `fallback` when `v` is null/undefined |
| `coalesce(a, b, …)` | first non-empty argument |
| `json(v)` | JSON string of `v` |
| `parseJson(s)` | parse a JSON string |
| `len(v)` | length of a string/array, or key count of an object |

### Strings
`upper(s)` · `lower(s)` · `trim(s)` · `contains(s, sub)` ·
`startsWith(s, prefix)` · `endsWith(s, suffix)` · `replace(s, find, with)`
(all occurrences) · `split(s, sep)` · `substr(s, start[, end])` ·
`padStart(s, width[, pad])` · `padEnd(s, width[, pad])` · `indexOf(s, sub)`.

`contains` and `indexOf` also work on arrays.

### Numbers & math
`abs(x)` · `round(x[, digits])` · `floor(x)` · `ceil(x)` · `sqrt(x)` ·
`pow(x, e)` · `min(…)` · `max(…)` (loose args or a single array) ·
`clamp(x, lo, hi)` · `sum(arr)` · `avg(arr)`.

### Arrays
`first(arr)` · `last(arr)` · `join(arr, sep)` · `reverse(arr)` · `sort(arr)` ·
`unique(arr)` · `slice(arr, start[, end])` · `len(arr)`.

### Objects
`keys(obj)` · `values(obj)` · `has(obj, key)` ·
`get(obj, "a.b.c"[, fallback])` (safe dotted-path lookup).

### Time & dates
`now()` (ISO-8601 string) · `nowMs()` (epoch milliseconds) — the run's clock,
for rules like `nowMs() - created > 86400000`.

Date helpers work over an ISO-8601 string **or** epoch milliseconds, all reading
UTC (like the schedule engine), so a rule behaves the same regardless of the
server's timezone:

- `parseDate(v)` → normalized ISO string · `year(v)` · `month(v)` (1–12) ·
  `day(v)` · `hour(v)` · `minute(v)` · `weekday(v)` (0–6, Sunday = 0)
- `dateAdd(when, amount, unit)` → ISO string; `dateDiff(a, b, unit)` → `b − a` in
  `unit` (may be fractional). `unit` ∈ `seconds` | `minutes` | `hours` | `days`.
- `isBefore(a, b)` · `isAfter(a, b)`

```
dateDiff(order.createdAt, now(), "days") > 7      // older than a week
weekday(now()) == 0 || weekday(now()) == 6        // fired on a weekend
isBefore(now(), subscription.expiresAt)           // still active
```

---

## Safety model

- **No evaluation path.** FXL is lexed → parsed → tree-walked. There is no
  `eval`/`Function`/`vm`; a string is inert data, never re-interpreted as code.
- **No host reach.** Identifiers resolve only against the scope above; calls
  only against the function table above. There are no methods on values, no
  `this`, and no globals — `"x".constructor` or `payload.toString()` simply
  don't parse.
- **Prototype-safe.** Member access never traverses `__proto__`, `prototype`,
  or `constructor`.
- **Bounded.** Evaluation has a step limit and a recursion-depth cap, and the
  parser rejects a pathologically large expression, so a crafted rule can't
  monopolise a worker.

---

## Examples

```
# tiered routing
amount > 10000 ? "exec-approval" : amount > 1000 ? "manager-approval" : "auto"

# normalise then compare
endsWith(upper(trim(user.email)), "@ACME.COM")

# keep recent, high-value orders (Filter predicate)
total >= 100 && nowMs() - createdMs < 7 * 86400000

# reshape each row (Map mapping)
{ id: item.id, name: upper(trim(name)), total: round(price * qty, 2) }

# revenue per region (Aggregate: value `price * qty`, group-by `region`)
price * qty

# defend against missing data
get(payload, "customer.tier", "standard") == "gold"

# membership
status in ["open", "reopened"] && !(assignee in ["", null])
```
