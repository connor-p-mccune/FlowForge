import { useState } from 'react'
import Header from './Header'
import Sidebar from './Sidebar'

// Shared chrome for every authenticated page: header on top, sidebar + main
// below. Owns the sidebar's open/closed state so the header's menu button (only
// visible on narrow screens) can toggle it; on wide screens the sidebar is
// always shown and the backdrop/toggle are hidden via CSS.
export default function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="app-layout">
      <Header onToggleSidebar={() => setSidebarOpen((v) => !v)} />
      <div className="app-body">
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
        <main className="app-main">{children}</main>
      </div>
    </div>
  )
}
