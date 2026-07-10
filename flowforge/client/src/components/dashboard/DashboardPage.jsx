import AppShell from '../layout/AppShell'
import ApprovalsInbox from './ApprovalsInbox'

export default function DashboardPage() {
  return (
    <AppShell>
      <div className="dashboard__empty-state">
        <h2 className="dashboard__empty-title">Welcome to FlowForge</h2>
        <p className="dashboard__empty-hint">
          Select a workflow from the sidebar, or create a new one with the + button.
        </p>
        <ApprovalsInbox />
      </div>
    </AppShell>
  )
}
