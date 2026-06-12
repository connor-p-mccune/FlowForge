const MAX_DELAY_MS = 5 * 60 * 1000

module.exports = async function runDelay(config, input) {
  const requested = Number(config.durationMs ?? 0)
  const ms = Math.min(Math.max(requested, 0), MAX_DELAY_MS)
  await new Promise((resolve) => setTimeout(resolve, ms))
  // pass upstream data through so a delay doesn't break the chain
  return { ...input, delayedMs: ms }
}
