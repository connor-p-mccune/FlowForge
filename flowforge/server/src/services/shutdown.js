// Graceful shutdown coordinator.
//
// On SIGTERM/SIGINT the process drains instead of dying mid-run: index.js
// registers closers in dependency order (stop accepting HTTP → pause the Bull
// worker, which waits for in-flight runs to settle → stop background timers →
// close Socket.io, Redis, SQLite), and this module runs them sequentially.
// Because the engine's cancellation/approval machinery keeps all cross-step
// state in SQLite rows, a run that survives the drain window resumes cleanly
// after restart via resume-from-failure — but letting in-flight runs finish
// is still strictly better than tearing them down mid-node.
//
// A hard deadline (SHUTDOWN_TIMEOUT_MS, default 30s) backstops the drain: if
// a closer hangs — a run that won't settle, a socket that won't close — the
// process force-exits rather than wedging the deploy. A second signal during
// the drain also force-exits, so an operator's ^C^C still works.

const logger = require('./logger')

const closers = [] // { name, fn }, run in registration order
let shuttingDown = false

function isShuttingDown() {
  return shuttingDown
}

// Register a named closer. fn may be sync or return a promise.
function onShutdown(name, fn) {
  closers.push({ name, fn })
}

async function shutdown(signal, { exit = process.exit, timeoutMs } = {}) {
  if (shuttingDown) {
    logger.warn('second shutdown signal — exiting immediately', { signal })
    exit(1)
    return
  }
  shuttingDown = true
  const deadline = Number.isFinite(timeoutMs)
    ? timeoutMs
    : Number(process.env.SHUTDOWN_TIMEOUT_MS || 30_000)
  logger.info('shutdown started', { signal, closers: closers.map((c) => c.name) })

  const timer = setTimeout(() => {
    logger.error('shutdown deadline exceeded — exiting hard', { timeoutMs: deadline })
    exit(1)
  }, deadline)
  timer.unref?.()

  // Sequential on purpose: each closer may depend on the previous one (the
  // worker must drain before Redis closes under it). A closer that fails is
  // logged and skipped — the rest still get their chance to clean up.
  let failed = false
  for (const { name, fn } of closers) {
    try {
      await fn()
      logger.info('component closed', { component: name })
    } catch (err) {
      failed = true
      logger.error('component close failed', { component: name, error: err.message })
    }
  }

  clearTimeout(timer)
  logger.info('shutdown complete', { clean: !failed })
  exit(failed ? 1 : 0)
}

function installSignalHandlers() {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      shutdown(signal).catch((err) => {
        logger.error('shutdown crashed', { error: err.message })
        process.exit(1)
      })
    })
  }
}

// Test hook: clear registered closers and the in-progress flag.
function _reset() {
  closers.length = 0
  shuttingDown = false
}

module.exports = { onShutdown, shutdown, isShuttingDown, installSignalHandlers, _reset }
