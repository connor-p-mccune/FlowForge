import { useState, useContext, createContext } from 'react'
import { apiFetch } from '../services/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })

  async function login(email, password) {
    const { token, user: u } = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(u))
    setUser(u)
  }

  async function register(email, password, displayName) {
    const { token, user: u } = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
    })
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(u))
    setUser(u)
  }

  function logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
