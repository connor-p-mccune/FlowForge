// Run cost accounting.
//
// A workflow platform quietly spends money on its owner's behalf — an AI node
// in a loop over a thousand records is a real invoice — and until now nothing
// here could answer "what did that cost?", let alone "stop when it reaches
// $50". This module is the pricing half; services/budget.js is the enforcement
// half.
//
// **What is priced, and what deliberately isn't.** Only AI token usage carries
// a price, because it is the only cost FlowForge can actually know: the tokens
// are metered by the provider, reported on the response, and multiplied by a
// published rate. An HTTP node calling a third-party API also costs money —
// but FlowForge has no idea what that vendor charges, and inventing a number
// would produce a total that looks authoritative and is fiction. So external
// calls are *counted*, not priced, unless the workflow author supplies their
// own rate (`config.costPerCall`), which is the only party who could know it.
//
// All money is integer **micro-USD** (1e-6 USD). Floating-point dollars
// accumulate rounding error across thousands of steps and then disagree with
// themselves when you sum the same rows two different ways; an integer count of
// millionths does not. Formatting happens once, at the edge.

// Published per-1M-token rates, in micro-USD, for the models this deployment is
// likely to use. Matching is longest-prefix, because providers return dated
// snapshots ('gpt-4o-mini-2024-07-18') that must price like their family.
//
// A price table in source will age. It is overridable wholesale with
// COST_MODEL_PRICES (JSON), and an unknown model prices at zero *and says so*
// via `priced: false` — a visible gap beats a confident wrong number, and the
// UI surfaces unpriced steps rather than hiding them in a total.
const DEFAULT_PRICES = {
  'gpt-4o-mini': { input: 150_000, output: 600_000 },
  'gpt-4o': { input: 2_500_000, output: 10_000_000 },
  'gpt-4.1-mini': { input: 400_000, output: 1_600_000 },
  'gpt-4.1': { input: 2_000_000, output: 8_000_000 },
  'o4-mini': { input: 1_100_000, output: 4_400_000 },
}

let cachedPrices = null
let cachedRaw = null

// Read the table once per distinct env value, so a deployment can override it
// without a restart-only code path and tests can vary it freely.
function prices() {
  const raw = process.env.COST_MODEL_PRICES
  if (raw === cachedRaw && cachedPrices) return cachedPrices
  cachedRaw = raw
  cachedPrices = DEFAULT_PRICES
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') cachedPrices = parsed
    } catch {
      console.error('COST_MODEL_PRICES is not valid JSON; using the built-in price table')
    }
  }
  return cachedPrices
}

// The rate for a model name, matched by longest prefix so dated snapshots
// inherit their family's price. Returns null when nothing matches.
function rateFor(model) {
  if (typeof model !== 'string' || model === '') return null
  const table = prices()
  if (table[model]) return table[model]
  let best = null
  let bestLength = 0
  for (const [name, rate] of Object.entries(table)) {
    if (model.startsWith(name) && name.length > bestLength) {
      best = rate
      bestLength = name.length
    }
  }
  return best
}

// Price one AI call's usage.
//
// Returns { microUsd, priced, model, promptTokens, completionTokens } — always
// an object, never a throw. Cost accounting sits inside the engine's hot path
// and is bookkeeping: a run that would have succeeded must never fail because
// its invoice line couldn't be computed.
function priceUsage(usage) {
  const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
  const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
  const model = typeof usage?.model === 'string' ? usage.model : null
  const rate = rateFor(model)
  if (!rate) {
    return { microUsd: 0, priced: false, model, promptTokens, completionTokens }
  }
  // Rates are per 1M tokens; round to whole micro-USD at the last step so a
  // long run's total doesn't drift by fractions per call.
  const microUsd = Math.round(
    (promptTokens * (Number(rate.input) || 0) + completionTokens * (Number(rate.output) || 0)) /
      1_000_000
  )
  return { microUsd, priced: true, model, promptTokens, completionTokens }
}

// Node types that reach an external system and therefore *may* cost money the
// platform can't see. Counted always; priced only if the author says what a
// call costs them.
const METERED_CALL_TYPES = new Set(['action-http', 'action-email', 'action-slack'])

// A per-call price the workflow author declared on the node
// (`config.costPerCall`, in USD — the unit a human reading a vendor's pricing
// page has in hand). Read from the *raw* config like `onError` and the cache
// policy, so upstream data can never inflate or zero out a cost figure.
function declaredCallCost(node) {
  if (!node || !METERED_CALL_TYPES.has(node.type)) return null
  const declared = Number(node.data?.config?.costPerCall)
  if (!Number.isFinite(declared) || declared <= 0) return null
  return Math.round(declared * 1_000_000)
}

// The engine's entry point: what did this step cost, and what did it use?
//
// `output` is the runner's return value, from which a reserved `usage` key is
// read (AI nodes report it there). Returns null when there is nothing to
// record, so the engine writes no columns for the overwhelming majority of
// steps — a transform node has neither a price nor a call to count.
function meterStep(node, output) {
  const usage = output && typeof output === 'object' ? output.usage : null
  if (usage && typeof usage === 'object') {
    const priced = priceUsage(usage)
    return {
      microUsd: priced.microUsd,
      usage: {
        kind: 'tokens',
        model: priced.model,
        promptTokens: priced.promptTokens,
        completionTokens: priced.completionTokens,
        // The honest flag: an unpriced model contributes 0 to the total, and
        // every surface that shows a total can say how much of it is unknown.
        priced: priced.priced,
      },
    }
  }
  if (METERED_CALL_TYPES.has(node?.type)) {
    const declared = declaredCallCost(node)
    return {
      microUsd: declared ?? 0,
      usage: { kind: 'call', calls: 1, priced: declared != null },
    }
  }
  return null
}

// "$1.23" / "$0.0042" / "<$0.0001" — micro-USD rendered for a human. Small
// amounts keep four decimals because a single AI call routinely costs less
// than a cent, and rounding every step to $0.00 would make the per-step view
// useless exactly where it is most needed.
function formatMicroUsd(microUsd) {
  const value = Number(microUsd) || 0
  if (value === 0) return '$0.00'
  const usd = value / 1_000_000
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

module.exports = {
  DEFAULT_PRICES,
  METERED_CALL_TYPES,
  rateFor,
  priceUsage,
  declaredCallCost,
  meterStep,
  formatMicroUsd,
}
