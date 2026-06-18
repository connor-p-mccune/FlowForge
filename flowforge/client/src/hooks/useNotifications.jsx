import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react'
import socket from '../services/socket'
import { apiFetch } from '../services/api'
import { useAuth } from './useAuth'

// App-wide in-app notifications. Mounted once (in ProtectedRoute) so it persists
// across navigation: it fetches the initial list/unread count on login, keeps a
// live Socket.io connection, and prepends notifications pushed to the user's
// personal room — all surfaced through the bell in the header.
const NotificationsContext = createContext(null)

export function NotificationsProvider({ children }) {
  const { user } = useAuth()
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch('/api/notifications')
      setNotifications(data.notifications || [])
      setUnreadCount(data.unreadCount || 0)
    } catch {
      // Non-fatal — the bell keeps its current state until the next refresh.
    }
  }, [])

  // Track mounted state so the disconnect handler doesn't reconnect after logout.
  const activeRef = useRef(false)

  useEffect(() => {
    if (!user) {
      setNotifications([])
      setUnreadCount(0)
      if (socket.connected) socket.disconnect()
      return
    }

    activeRef.current = true
    let connectedOnce = socket.connected

    setLoading(true)
    refresh().finally(() => { if (activeRef.current) setLoading(false) })

    // Own an app-lifetime connection. The canvas (useSocket) connects/disconnects
    // per workflow; we re-establish the socket if that teardown — or a network
    // blip — drops it. The server re-joins the user:<id> room on every connect,
    // so the listener below keeps receiving once reconnected.
    socket.auth = { token: localStorage.getItem('token') }
    if (!socket.connected) socket.connect()

    const onNew = ({ notification }) => {
      if (!notification) return
      setNotifications((prev) =>
        prev.some((n) => n.id === notification.id) ? prev : [notification, ...prev]
      )
      if (!notification.is_read) setUnreadCount((c) => c + 1)
    }
    const onConnect = () => {
      // Resync after a reconnect to catch anything missed while disconnected.
      // (Skip the very first connect — the mount already fetched.)
      if (connectedOnce) refresh()
      connectedOnce = true
    }
    const onDisconnect = () => {
      if (activeRef.current) socket.connect()
    }

    socket.on('new-notification', onNew)
    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)

    return () => {
      activeRef.current = false
      socket.off('new-notification', onNew)
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
    }
  }, [user, refresh])

  // Mark one read — optimistic, with a server resync if the request fails.
  const markRead = useCallback(async (id) => {
    let wasUnread = false
    setNotifications((prev) =>
      prev.map((n) => {
        if (n.id === id && !n.is_read) {
          wasUnread = true
          return { ...n, is_read: 1 }
        }
        return n
      })
    )
    if (wasUnread) setUnreadCount((c) => Math.max(0, c - 1))
    try {
      await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' })
    } catch {
      refresh()
    }
  }, [refresh])

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => (n.is_read ? n : { ...n, is_read: 1 })))
    setUnreadCount(0)
    try {
      await apiFetch('/api/notifications/read-all', { method: 'PUT' })
    } catch {
      refresh()
    }
  }, [refresh])

  return (
    <NotificationsContext.Provider
      value={{ notifications, unreadCount, loading, markRead, markAllRead, refresh }}
    >
      {children}
    </NotificationsContext.Provider>
  )
}

export const useNotifications = () => useContext(NotificationsContext)
