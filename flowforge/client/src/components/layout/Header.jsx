import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

export default function Header({ onToggleSidebar }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
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
        {user && <span className="header__user">{user.displayName}</span>}
        <button className="header__logout" onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </header>
  )
}
