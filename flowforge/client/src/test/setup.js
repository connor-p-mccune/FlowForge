import '@testing-library/jest-dom/vitest'

// React Flow reaches for ResizeObserver, which jsdom doesn't implement.
// A no-op shim is enough for rendering nodes and their handles in tests.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
