// Declared field redaction — keeping personal data out of what FlowForge stores.
//
// Secrets are already scrubbed from everything the engine persists or publishes:
// a decrypted credential lives in memory for one run, and a redactor built from
// its value masks it out of step rows, published events and error messages
// (`executionEngine.js`, `buildRedactor`). That mechanism is exactly right for a
// second class of data it was never pointed at.
//
// A webhook body routinely carries an email address, a customer name, a postal
// address, an order full of them. None of that is a credential, so none of it is
// encrypted — and all of it lands verbatim in `execution_steps`, in the run
// detail panel, in an `exec-update` every collaborator watching the canvas
// receives, and in whatever backup that database has. A workflow that processes
// personal data therefore accumulates it in a place nobody chose to put it, for
// as long as run history is kept.
//
// So a workflow can declare which of its trigger's fields are personal, and
// those values join the run's redactor.
//
// ## By value, not by path
//
// The declaration names a path, but what is masked is the **value**. That is the
// whole reason this is worth doing: an email declared once is scrubbed from the
// trigger step that received it, from the HTTP node's request body that
// interpolated it, from the response a third party echoed it back in, and from
// the error message that quoted it. Masking the declared *location* would scrub
// exactly one of those and leave the rest — which is the version of this feature
// that looks like it works.
//
// ## Resolved at run start, from the trigger payload
//
// Personal data enters a workflow at its trigger, which is also the only place
// its values are known before anything executes. A field that first appears in
// an HTTP response cannot be pre-registered, and that limit is stated rather
// than papered over: [lineage](./lineage.js) already answers where trigger data
// travels, so declaring it at the point it enters is where the declaration
// belongs anyway.
//
// ## What this is not
//
// It is not encryption and it is not a firewall. The value still flows through
// the engine in memory, and a node that sends it to an API still sends it — that
// is what the workflow is for. This governs what FlowForge **keeps and shows**.
// Reading it as "declaring a field stops it leaving" would be a dangerous
// misunderstanding, so the UI and the docs say so in as many words.

// A declaration is a dotted path (`email`, `customer.address.line1`), optionally
// prefixed with a trigger node's id the way a `{{…}}` reference would be.
const PATH = /^[\w-]+(\.[\w-]+)*$/

// Bounds. The redactor scrubs by string replacement, so its cost is
// (values × persisted strings) per run — a declaration list nobody would write
// by hand must not be able to make every step write quadratic.
const MAX_PATHS = 50
const MAX_VALUES = 200

// How deep a declared object is walked when collecting the strings inside it.
const MAX_DEPTH = 6

// Parse a stored declaration into a clean list of paths. Strict and total, like
// `parseGuarantees`: anything malformed is dropped here rather than carried
// into the engine as a rule that would quietly never match.
function parseRedactions(raw) {
  let list = raw
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    // Accept the `{{…}}` spelling too — it is what an author copies out of the
    // data picker, and refusing it would be a papercut with no upside.
    const path = item.trim().replace(/^\{\{\s*|\s*\}\}$/g, '')
    if (!PATH.test(path) || seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length >= MAX_PATHS) break
  }
  return out
}

// Every string inside a value, to a bounded depth. Declaring `customer` should
// mask the name and the email inside it — the alternative is a declaration per
// leaf, which is how a field gets missed.
function stringsIn(value, depth, out) {
  if (out.length >= MAX_VALUES || depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, depth + 1, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) stringsIn(item, depth + 1, out)
  }
}

function lookup(payload, segments) {
  let current = payload
  for (const key of segments) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

// The values this run must mask, given its declarations and its trigger payload.
//
// A path that resolves to nothing contributes nothing — and that is normal
// rather than an error, because a payload's optional field is absent on the runs
// that do not carry it. Reporting it would make every such run noisy about
// working correctly.
//
// `triggerNodeIds` lets a declaration be written either way: `email` reads the
// payload directly, and `hook.email` reads it through the trigger node's id, the
// way every other reference in the product is written. Only a *trigger* id is
// stripped — a non-trigger head would be a reference to a node's output, which
// this cannot resolve before the run and which the linter reports instead.
function valuesFor(raw, { triggerPayload, triggerNodeIds = new Set() } = {}) {
  const paths = parseRedactions(raw)
  if (paths.length === 0 || !triggerPayload || typeof triggerPayload !== 'object') return []

  const values = []
  for (const path of paths) {
    const segments = path.split('.')
    const relative =
      segments.length > 1 && triggerNodeIds.has(segments[0]) ? segments.slice(1) : segments
    stringsIn(lookup(triggerPayload, relative), 0, values)
    if (values.length >= MAX_VALUES) break
  }
  // Deduplicated: two declarations that resolve to the same value would
  // otherwise make the scrubber do the same replacement twice on every string.
  return [...new Set(values)]
}

// Lint support. A declaration whose head names a node that is *not* a trigger
// can never resolve — this reads the trigger payload, and a node's output does
// not exist when the redactor is built. Silent about a path that simply is not
// in today's payload, which is the ordinary case for an optional field.
function unresolvablePaths(raw, { nodeIds = new Set(), triggerNodeIds = new Set() } = {}) {
  return parseRedactions(raw).filter((path) => {
    const head = path.split('.')[0]
    return nodeIds.has(head) && !triggerNodeIds.has(head)
  })
}

module.exports = {
  MAX_PATHS,
  MAX_VALUES,
  MAX_DEPTH,
  parseRedactions,
  valuesFor,
  unresolvablePaths,
}
