import { useState, useContext, createContext } from 'react'
import { apiFetch } from '../services/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('user')
    return stored ? JSON.parse(stored) : null
  })

  function persistSession({ token, user: u }) {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(u))
    setUser(u)
  }

  // When the account has 2FA enabled the backend withholds the session token and
  // returns a short-lived challenge token instead. We surface that to the caller
  // (the login page) so it can prompt for a code; only a full { token, user }
  // response logs the user in.
  async function login(email, password) {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    if (res.requires2FA) {
      return { requires2FA: true, tempToken: res.tempToken }
    }
    persistSession(res)
    return { requires2FA: false }
  }

  // Second step of a 2FA login: exchange the challenge token + a code (TOTP or a
  // backup code) for a real session.
  async function loginWith2FA(tempToken, code) {
    const res = await apiFetch('/api/auth/2fa/login', {
      method: 'POST',
      body: { tempToken, code },
    })
    persistSession(res)
  }

  async function register(email, password, displayName) {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: { email, password, displayName },
    })
    persistSession(res)
  }

  function logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, loginWith2FA, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
