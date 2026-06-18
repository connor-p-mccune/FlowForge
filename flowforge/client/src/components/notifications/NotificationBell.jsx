import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '../../hooks/useNotifications'

// Icon per notification type, with a sensible fallback.
const ICONS = {
  'execution-failed': '⚠️',
  'workspace-invite': '👥',
}

function timeAgo(iso) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.floor((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function NotificationBell() {
  const ctx = useNotifications()
  const { notifications = [], unreadCount = 0, markRead = () => {}, markAllRead = () => {} } = ctx || {}
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function handleOpenNotification(notification) {
    if (!notification.is_read) markRead(notification.id)
    setOpen(false)
    if (notification.link) navigate(notification.link)
  }

  const recent = notifications.slice(0, 10)
  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount)

  return (
    <div className="notif" ref={ref}>
      <button
        type="button"
        className="notif__bell"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="notif__bell-icon" aria-hidden="true">🔔</span>
        {unreadCount > 0 && <span className="notif__badge">{badgeLabel}</span>}
      </button>

      {open && (
        <div className="notif__dropdown" role="menu">
          <div className="notif__head">
            <span className="notif__head-title">Notifications</span>
            {unreadCount > 0 && (
              <button type="button" className="notif__mark-all" onClick={markAllRead}>
                Mark all as read
              </button>
            )}
          </div>

          {recent.length === 0 ? (
            <p className="notif__empty">You’re all caught up.</p>
          ) : (
            <ul className="notif__list">
              {recent.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`notif__item${n.is_read ? '' : ' notif__item--unread'}`}
                    onClick={() => handleOpenNotification(n)}
                  >
                    <span className="notif__icon" aria-hidden="true">{ICONS[n.type] || '🔔'}</span>
                    <span className="notif__body">
                      <span className="notif__title">{n.title}</span>
                      {n.message && <span className="notif__message">{n.message}</span>}
                      <span className="notif__time">{timeAgo(n.created_at)}</span>
                    </span>
                    {!n.is_read && <span className="notif__dot" aria-hidden="true" />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
