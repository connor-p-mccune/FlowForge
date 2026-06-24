import { useEffect, useRef } from 'react'
import socket from '../services/socket'

// Subscribe to a workspace's live activity feed (the workspace:<id> room). Mirrors
// useSocket, but workspace-scoped and connection-SAFE: it joins/leaves the room and
// adds/removes its own `activity-event` listener, but never disconnects the shared
// socket — the app-wide NotificationsProvider owns the connection lifecycle (and
// re-connects if a per-page hook ever drops it). handlers.onEvent(event) fires for
// each new event; handlers.onReconnect fires after the socket drops and comes back
// (use it to refetch and catch anything missed while offline).
export function useWorkspaceActivity(workspaceId, handlers = {}) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const lostRef = useRef(false) // true while we believe the connection is down

  useEffect(() => {
    if (!workspaceId) return

    socket.auth = { token: localStorage.getItem('token') }
    if (!socket.connected) socket.connect()

    const joinRoom = () => socket.emit('join-workspace', { workspaceId })
    const onConnect = () => {
      joinRoom() // (re-)join on first connect and after reconnects
      if (lostRef.current) {
        lostRef.current = false
        handlersRef.current.onReconnect?.()
      }
    }
    // Flag a real outage so onReconnect can fire on the next connect. Ignore our
    // own teardown disconnect (reason 'io client disconnect').
    const onDisconnect = (reason) => {
      if (reason === 'io client disconnect') return
      lostRef.current = true
    }
    const onActivityEvent = (payload) => {
      if (payload && payload.event) handlersRef.current.onEvent?.(payload.event)
    }

    if (socket.connected) joinRoom()
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('activity-event', onActivityEvent)

    return () => {
      socket.emit('leave-workspace', { workspaceId })
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('activity-event', onActivityEvent)
      // NOTE: intentionally NOT calling socket.disconnect() — the app-wide
      // NotificationsProvider owns the shared connection's lifecycle.
    }
  }, [workspaceId])

  return socket
}
