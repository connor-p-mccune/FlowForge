import { useEffect, useState } from 'react'
import Header from './Header'
import Sidebar from './Sidebar'
import CommandPalette from '../palette/CommandPalette'

// Shared chrome for every authenticated page: header on top, sidebar + main
// below. Owns the sidebar's open/closed state so the header's menu button (only
// visible on narrow screens) can toggle it; on wide screens the sidebar is
// always shown and the backdrop/toggle are hidden via CSS. Also hosts the
// global command palette and its Ctrl/⌘-K shortcut, so search works on every
// authenticated page.
export default function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault() // browsers bind Ctrl+K to the address bar search
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="app-layout">
      <Header
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenSearch={() => setPaletteOpen(true)}
      />
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
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
