import { BrowserRouter, Routes, Route, useParams, Navigate } from 'react-router-dom'
import LoginPage from './components/auth/LoginPage'
import RegisterPage from './components/auth/RegisterPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import DashboardPage from './components/dashboard/DashboardPage'
import WorkflowCanvas from './components/canvas/WorkflowCanvas'
import Header from './components/layout/Header'
import Sidebar from './components/layout/Sidebar'

function WorkflowPage() {
  const { id } = useParams()
  return (
    <div className="app-layout">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          <WorkflowCanvas workflowId={id} />
        </main>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/workflow/:id" element={<WorkflowPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
