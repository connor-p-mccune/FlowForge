import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom'
import LoginPage from './components/auth/LoginPage'
import RegisterPage from './components/auth/RegisterPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import DashboardPage from './components/dashboard/DashboardPage'
import AppShell from './components/layout/AppShell'
import ErrorBoundary from './components/ErrorBoundary'
import RouteFallback from './components/RouteFallback'
import { ToastProvider } from './hooks/useToast'

// Routes are split at the router, not eagerly imported, and the canvas is the
// reason. It pulls in React Flow, the whole node library, and every panel —
// which is most of the bundle — and someone landing on the login page should
// not download a graph editor to type a password.
//
// Login, register and the dashboard stay eager on purpose: they are the first
// thing almost every session renders, and a spinner on the way to the page you
// asked for is worse than the bytes it saved. Everything else is a deliberate
// navigation, where a brief fallback is invisible next to the click that caused
// it.
const WorkflowCanvas = lazy(() => import('./components/canvas/WorkflowCanvas'))
const AnalyticsPage = lazy(() => import('./components/analytics/AnalyticsPage'))
const ActivityPage = lazy(() => import('./components/activity/ActivityPage'))
const AuditPage = lazy(() => import('./components/audit/AuditPage'))
const SecretsPage = lazy(() => import('./components/secrets/SecretsPage'))
const VariablesPage = lazy(() => import('./components/variables/VariablesPage'))
const PoliciesPage = lazy(() => import('./components/policies/PoliciesPage'))
const WebhooksPage = lazy(() => import('./components/webhooks/WebhooksPage'))
const SettingsPage = lazy(() => import('./components/settings/SettingsPage'))
const StatusPage = lazy(() => import('./components/status/StatusPage'))

// Every workspace-scoped page is the same shape: read :wsId, render inside the
// shell. One factory rather than eight near-identical wrappers.
function workspaceRoute(Page) {
  return function WorkspaceRoute() {
    const { wsId } = useParams()
    return (
      <AppShell>
        <Page workspaceId={wsId} />
      </AppShell>
    )
  }
}

const AnalyticsRoute = workspaceRoute(AnalyticsPage)
const ActivityRoute = workspaceRoute(ActivityPage)
const AuditRoute = workspaceRoute(AuditPage)
const SecretsRoute = workspaceRoute(SecretsPage)
const VariablesRoute = workspaceRoute(VariablesPage)
const PoliciesRoute = workspaceRoute(PoliciesPage)
const WebhooksRoute = workspaceRoute(WebhooksPage)

function WorkflowPage() {
  const { id } = useParams()
  return (
    <AppShell>
      <WorkflowCanvas workflowId={id} />
    </AppShell>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <BrowserRouter>
          {/* One boundary around the router rather than one per route: the
              fallback is the same everywhere, and a chunk that fails to load
              (a deploy mid-session) should reach the error boundary above
              rather than be caught eight times over. */}
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              {/* Public: the token in the URL is the whole credential. */}
              <Route path="/status/:token" element={<StatusPage />} />
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/workflow/:id" element={<WorkflowPage />} />
                <Route path="/workspace/:wsId/analytics" element={<AnalyticsRoute />} />
                <Route path="/workspace/:wsId/activity" element={<ActivityRoute />} />
                <Route path="/workspace/:wsId/audit" element={<AuditRoute />} />
                <Route path="/workspace/:wsId/secrets" element={<SecretsRoute />} />
                <Route path="/workspace/:wsId/variables" element={<VariablesRoute />} />
                <Route path="/workspace/:wsId/policies" element={<PoliciesRoute />} />
                <Route path="/workspace/:wsId/webhooks" element={<WebhooksRoute />} />
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
          </Suspense>
        </BrowserRouter>
      </ToastProvider>
    </ErrorBoundary>
  )
}
