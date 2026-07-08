import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom'
import LoginPage from './components/auth/LoginPage'
import RegisterPage from './components/auth/RegisterPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import DashboardPage from './components/dashboard/DashboardPage'
import AnalyticsPage from './components/analytics/AnalyticsPage'
import ActivityPage from './components/activity/ActivityPage'
import SecretsPage from './components/secrets/SecretsPage'
import SettingsPage from './components/settings/SettingsPage'
import WorkflowCanvas from './components/canvas/WorkflowCanvas'
import AppShell from './components/layout/AppShell'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastProvider } from './hooks/useToast'

function WorkflowPage() {
  const { id } = useParams()
  return (
    <AppShell>
      <WorkflowCanvas workflowId={id} />
    </AppShell>
  )
}

function AnalyticsRoute() {
  const { wsId } = useParams()
  return (
    <AppShell>
      <AnalyticsPage workspaceId={wsId} />
    </AppShell>
  )
}

function ActivityRoute() {
  const { wsId } = useParams()
  return (
    <AppShell>
      <ActivityPage workspaceId={wsId} />
    </AppShell>
  )
}

function SecretsRoute() {
  const { wsId } = useParams()
  return (
    <AppShell>
      <SecretsPage workspaceId={wsId} />
    </AppShell>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/workflow/:id" element={<WorkflowPage />} />
              <Route path="/workspace/:wsId/analytics" element={<AnalyticsRoute />} />
              <Route path="/workspace/:wsId/activity" element={<ActivityRoute />} />
              <Route path="/workspace/:wsId/secrets" element={<SecretsRoute />} />
              <Route
                path="/settings"
                element={
                  <AppShell>
                    <SettingsPage />
                  </AppShell>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}
