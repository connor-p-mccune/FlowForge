import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { NotificationsProvider } from '../../hooks/useNotifications'

export default function ProtectedRoute() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  // Wrap the authenticated app so notifications are fetched once and stay live
  // across navigation (the bell in the header consumes this).
  return (
    <NotificationsProvider>
      <Outlet />
    </NotificationsProvider>
  )
}
