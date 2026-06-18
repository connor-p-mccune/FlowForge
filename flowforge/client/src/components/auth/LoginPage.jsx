import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

export default function LoginPage() {
  const { login, loginWith2FA } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // When the account has 2FA enabled, the password step hands back a challenge
  // token and we slide in a second step asking for the code.
  const [tempToken, setTempToken] = useState(null)
  const [code, setCode] = useState('')

  async function handlePassword(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const { requires2FA, tempToken: tt } = await login(email, password)
      if (requires2FA) {
        setTempToken(tt)
      } else {
        navigate('/')
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await loginWith2FA(tempToken, code)
      navigate('/')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function backToPassword() {
    setTempToken(null)
    setCode('')
    setError(null)
    setPassword('')
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-card__title">FlowForge</h1>

        {!tempToken ? (
          <>
            <h2 className="auth-card__subtitle">Sign in</h2>
            <form className="auth-form" onSubmit={handlePassword}>
              <label className="auth-form__label">
                Email
                <input
                  className="auth-form__input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label className="auth-form__label">
                Password
                <input
                  className="auth-form__input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              {error && <p className="auth-form__error">{error}</p>}
              <button className="auth-form__submit" type="submit" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            <p className="auth-card__footer">
              No account? <Link to="/register">Register</Link>
            </p>
          </>
        ) : (
          <div className="auth-step">
            <h2 className="auth-card__subtitle">Two-factor authentication</h2>
            <p className="auth-step__hint">
              Enter the 6-digit code from your authenticator app, or one of your
              backup codes.
            </p>
            <form className="auth-form" onSubmit={handleVerify}>
              <label className="auth-form__label">
                Authentication code
                <input
                  className="auth-form__input auth-form__input--code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </label>
              {error && <p className="auth-form__error">{error}</p>}
              <button className="auth-form__submit" type="submit" disabled={loading || !code.trim()}>
                {loading ? 'Verifying…' : 'Verify'}
              </button>
            </form>
            <p className="auth-card__footer">
              <button type="button" className="auth-card__link-btn" onClick={backToPassword}>
                ← Back to sign in
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
