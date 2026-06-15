import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom'
import LoginPage from './components/auth/LoginPage'
import RegisterPage from './components/auth/RegisterPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import DashboardPage from './components/dashboard/DashboardPage'
import AnalyticsPage from './components/analytics/AnalyticsPage'
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
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}
