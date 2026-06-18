import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import NotificationBell from '../notifications/NotificationBell'

export default function Header({ onToggleSidebar }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  function handleLogout() {
    setMenuOpen(false)
    logout()
    navigate('/login')
  }

  function goToSettings() {
    setMenuOpen(false)
    navigate('/settings')
  }

  return (
    <header className="header">
      <div className="header__left">
        {onToggleSidebar && (
          <button
            className="header__menu-btn"
            aria-label="Toggle sidebar"
            onClick={onToggleSidebar}
          >
            ☰
          </button>
        )}
        <span className="header__logo">FlowForge</span>
      </div>
      <div className="header__right">
        {user && <NotificationBell />}
        {user ? (
          <div className="header__user-menu">
            <button
              className="header__user"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {user.displayName} <span className="header__caret" aria-hidden="true">▾</span>
            </button>
            {menuOpen && (
              <>
                <div
                  className="header__menu-backdrop"
                  onClick={() => setMenuOpen(false)}
                  aria-hidden="true"
                />
                <div className="header__menu" role="menu">
                  <button className="header__menu-item" role="menuitem" onClick={goToSettings}>
                    Settings
                  </button>
                  <button className="header__menu-item" role="menuitem" onClick={handleLogout}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button className="header__logout" onClick={handleLogout}>
            Sign out
          </button>
        )}
      </div>
    </header>
  )
}
