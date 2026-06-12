import Header from '../layout/Header'
import Sidebar from '../layout/Sidebar'

export default function DashboardPage() {
  return (
    <div className="app-layout">
      <Header />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          <div className="dashboard__empty-state">
            <h2 className="dashboard__empty-title">Welcome to FlowForge</h2>
            <p className="dashboard__empty-hint">
              Select a workflow from the sidebar, or create a new one with the + button.
            </p>
          </div>
        </main>
      </div>
    </div>
  )
}
