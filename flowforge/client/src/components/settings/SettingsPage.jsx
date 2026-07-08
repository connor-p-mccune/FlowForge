import { useState, useEffect } from 'react'
import { apiFetch } from '../../services/api'
import TwoFactorSetup from './TwoFactorSetup'
import ApiTokensSection from './ApiTokensSection'

// Account settings. For now this is the home of the Security section, where a
// user enables or disables TOTP two-factor authentication. The live 2FA status
// is read fresh from /auth/me (rather than the cached session user) so it stays
// correct right after enabling or disabling.
export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [error, setError] = useState(null)
  const [message, setMessage] = useState(null)

  const [showSetup, setShowSetup] = useState(false)
  const [showDisable, setShowDisable] = useState(false)
  const [showBackupNote, setShowBackupNote] = useState(false)

  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [disableError, setDisableError] = useState(null)
  const [disableBusy, setDisableBusy] = useState(false)

  async function loadStatus() {
    setLoading(true)
    try {
      const { user } = await apiFetch('/api/auth/me')
      setEnabled(!!user.twoFactorEnabled)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadStatus()
  }, [])

  function completeSetup() {
    setShowSetup(false)
    setMessage('Two-factor authentication is now enabled.')
    loadStatus()
  }

  function closeSetup() {
    // Setup may have flipped 2FA on before the modal was dismissed, so re-sync.
    setShowSetup(false)
    loadStatus()
  }

  async function handleDisable(e) {
    e.preventDefault()
    setDisableBusy(true)
    setDisableError(null)
    try {
      await apiFetch('/api/auth/2fa/disable', { method: 'POST', body: { password, code } })
      setShowDisable(false)
      setPassword('')
      setCode('')
      setMessage('Two-factor authentication has been disabled.')
      await loadStatus()
    } catch (err) {
      setDisableError(err.message)
    } finally {
      setDisableBusy(false)
    }
  }

  return (
    <div className="settings">
      <h1 className="settings__title">Settings</h1>

      <section className="settings__section">
        <h2 className="settings__section-title">Security</h2>

        <div className="settings__row">
          <div className="settings__row-main">
            <h3 className="settings__row-title">
              Two-factor authentication
              {enabled && <span className="settings__badge settings__badge--on">Enabled</span>}
              {!loading && !enabled && (
                <span className="settings__badge settings__badge--off">Off</span>
              )}
            </h3>
            <p className="settings__row-desc">
              Add a second step to sign-in using an authenticator app. After your
              password, you&apos;ll enter a 6-digit code.
            </p>
          </div>
        </div>

        {message && <p className="settings__message">{message}</p>}
        {error && <p className="settings__error">{error}</p>}

        {loading ? (
          <p className="settings__muted">Loading…</p>
        ) : enabled ? (
          <div className="settings__panel">
            <p className="settings__muted">
              Your account is protected with two-factor authentication.
            </p>

            <div className="settings__btn-row">
              <button
                className="settings__btn"
                onClick={() => setShowBackupNote((v) => !v)}
              >
                View backup codes
              </button>
              <button
                className="settings__btn settings__btn--danger"
                onClick={() => {
                  setShowDisable((v) => !v)
                  setDisableError(null)
                }}
              >
                Disable
              </button>
            </div>

            {showBackupNote && (
              <p className="settings__note">
                Backup codes are shown only once, when you first turn on two-factor
                authentication. If you&apos;ve lost them, disable and re-enable 2FA to
                generate a fresh set.
              </p>
            )}

            {showDisable && (
              <form className="settings__form" onSubmit={handleDisable}>
                <p className="settings__muted">
                  Confirm your password and a current code to turn off two-factor
                  authentication.
                </p>
                <label className="settings__label">
                  Password
                  <input
                    className="settings__input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label className="settings__label">
                  Authentication code (or backup code)
                  <input
                    className="settings__input"
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    required
                  />
                </label>
                {disableError && <p className="settings__error">{disableError}</p>}
                <div className="settings__btn-row">
                  <button
                    type="button"
                    className="settings__btn"
                    onClick={() => setShowDisable(false)}
                    disabled={disableBusy}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="settings__btn settings__btn--danger"
                    disabled={disableBusy || !password || !code.trim()}
                  >
                    {disableBusy ? 'Disabling…' : 'Disable 2FA'}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <div className="settings__panel">
            <button
              className="settings__btn settings__btn--primary"
              onClick={() => {
                setMessage(null)
                setShowSetup(true)
              }}
            >
              Enable two-factor authentication
            </button>
          </div>
        )}
      </section>

      <ApiTokensSection />

      {showSetup && <TwoFactorSetup onClose={closeSetup} onCompleted={completeSetup} />}
    </div>
  )
}
