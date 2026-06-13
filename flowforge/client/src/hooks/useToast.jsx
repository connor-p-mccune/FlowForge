import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import ToastViewport from '../components/Toast'

// App-wide transient notifications. Components/hooks call useToast() and fire
// toast.error(...) / toast.success(...) for things like a failed save, a failed
// run, or a dropped socket connection.
const ToastContext = createContext(null)

let nextId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef({})

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
    if (timers.current[id]) {
      clearTimeout(timers.current[id])
      delete timers.current[id]
    }
  }, [])

  const notify = useCallback(
    (message, { type = 'info', duration = 5000 } = {}) => {
      const id = ++nextId
      setToasts((list) => [...list, { id, message, type }])
      if (duration > 0) {
        timers.current[id] = setTimeout(() => dismiss(id), duration)
      }
      return id
    },
    [dismiss]
  )

  // Stable identity so consumers can safely list `toast` in effect/callback
  // deps without forcing re-runs every render.
  const value = useMemo(
    () => ({
      notify,
      dismiss,
      error: (m, o) => notify(m, { ...o, type: 'error', duration: o?.duration ?? 7000 }),
      success: (m, o) => notify(m, { ...o, type: 'success' }),
      info: (m, o) => notify(m, { ...o, type: 'info' }),
    }),
    [notify, dismiss]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

// No-op fallback so components used outside a provider (e.g. in tests) don't
// crash when they call useToast().
const NOOP = { notify: () => {}, dismiss: () => {}, error: () => {}, success: () => {}, info: () => {} }

export function useToast() {
  return useContext(ToastContext) || NOOP
}
