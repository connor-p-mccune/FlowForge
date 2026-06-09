import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

export default function Header() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  return (
    <header className="header">
      <span className="header__logo">FlowForge</span>
      <div className="header__right">
        {user && <span className="header__user">{user.displayName}</span>}
        <button className="header__logout" onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </header>
  )
}
