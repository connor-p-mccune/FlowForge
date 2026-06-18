import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../services/api'

// Guided 2FA enrolment modal, run in three steps:
//   1. scan   — show the QR code + the secret for manual entry
//   2. verify — confirm a 6-digit code so we know the authenticator works
//   3. backup — reveal the one-time backup codes, which can't be shown again
// The secret + codes come from POST /2fa/setup (called on open); /verify-setup
// is what actually flips 2FA on. On step 3 the modal can only be dismissed once
// the user ticks "I've saved these", since the codes are unrecoverable.
export default function TwoFactorSetup({ onClose, onCompleted }) {
  const [step, setStep] = useState('loading') // loading | scan | verify | backup
  const [data, setData] = useState(null) // { qrCode, secret, backupCodes }
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  // Backup codes are unrecoverable once this modal closes, so block dismissal on
  // the final step until the user confirms they've saved them.
  const locked = step === 'backup' && !saved

  const requestClose = useCallback(() => {
    if (!locked && !busy) onClose()
  }, [locked, busy, onClose])

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        const res = await apiFetch('/api/auth/2fa/setup', { method: 'POST' })
        if (cancelled) return
        setData(res)
        setStep('scan')
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }
    start()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') requestClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  async function verify(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/auth/2fa/verify-setup', { method: 'POST', body: { code } })
      setStep('backup')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function copyCodes() {
    navigator.clipboard?.writeText(data.backupCodes.join('\n')).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {}
    )
  }

  return createPortal(
    <div
      className="twofa-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Set up two-factor authentication"
      onClick={requestClose}
    >
      <div className="twofa-modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="twofa-modal__header">
          <h2 className="twofa-modal__title">Set up two-factor authentication</h2>
          <button
            className="twofa-modal__close"
            title="Close"
            onClick={requestClose}
            disabled={locked || busy}
          >
            ×
          </button>
        </header>

        <div className="twofa-modal__body">
          {step === 'loading' && !error && <p className="twofa-modal__loading">Preparing…</p>}

          {step === 'scan' && data && (
            <>
              <ol className="twofa-modal__steps" aria-label="progress">
                <li className="twofa-modal__step twofa-modal__step--active">Scan</li>
                <li className="twofa-modal__step">Verify</li>
                <li className="twofa-modal__step">Backup codes</li>
              </ol>
              <p className="twofa-modal__text">
                Scan this QR code with an authenticator app (Google Authenticator,
                Authy, 1Password…).
              </p>
              <img className="twofa-modal__qr" src={data.qrCode} alt="2FA QR code" />
              <p className="twofa-modal__text twofa-modal__text--muted">
                Can&apos;t scan? Enter this key manually:
              </p>
              <code className="twofa-modal__secret">{data.secret}</code>
              <div className="twofa-modal__actions">
                <button className="twofa-modal__btn" onClick={requestClose}>
                  Cancel
                </button>
                <button
                  className="twofa-modal__btn twofa-modal__btn--primary"
                  onClick={() => {
                    setError(null)
                    setStep('verify')
                  }}
                >
                  Next
                </button>
              </div>
            </>
          )}

          {step === 'verify' && (
            <>
              <ol className="twofa-modal__steps" aria-label="progress">
                <li className="twofa-modal__step">Scan</li>
                <li className="twofa-modal__step twofa-modal__step--active">Verify</li>
                <li className="twofa-modal__step">Backup codes</li>
              </ol>
              <p className="twofa-modal__text">
                Enter the 6-digit code shown in your authenticator app to confirm
                it&apos;s set up correctly.
              </p>
              <form className="twofa-modal__form" onSubmit={verify}>
                <input
                  className="twofa-modal__input"
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
                {error && <p className="twofa-modal__error">{error}</p>}
                <div className="twofa-modal__actions">
                  <button
                    type="button"
                    className="twofa-modal__btn"
                    onClick={() => {
                      setError(null)
                      setStep('scan')
                    }}
                    disabled={busy}
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className="twofa-modal__btn twofa-modal__btn--primary"
                    disabled={busy || !code.trim()}
                  >
                    {busy ? 'Verifying…' : 'Verify & enable'}
                  </button>
                </div>
              </form>
            </>
          )}

          {step === 'backup' && data && (
            <>
              <ol className="twofa-modal__steps" aria-label="progress">
                <li className="twofa-modal__step">Scan</li>
                <li className="twofa-modal__step">Verify</li>
                <li className="twofa-modal__step twofa-modal__step--active">Backup codes</li>
              </ol>
              <p className="twofa-modal__text twofa-modal__success">
                ✓ Two-factor authentication is now enabled.
              </p>
              <p className="twofa-modal__text">
                Save these backup codes somewhere safe. Each can be used once if you
                lose access to your authenticator. <strong>They won&apos;t be shown again.</strong>
              </p>
              <ul className="twofa-modal__codes">
                {data.backupCodes.map((c) => (
                  <li key={c} className="twofa-modal__code">
                    {c}
                  </li>
                ))}
              </ul>
              <button className="twofa-modal__copy" onClick={copyCodes}>
                {copied ? 'Copied!' : 'Copy codes'}
              </button>
              <label className="twofa-modal__confirm">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                I&apos;ve saved my backup codes
              </label>
              <div className="twofa-modal__actions">
                <button
                  className="twofa-modal__btn twofa-modal__btn--primary"
                  disabled={!saved}
                  onClick={onCompleted}
                >
                  Done
                </button>
              </div>
            </>
          )}

          {error && step !== 'verify' && (
            <>
              <p className="twofa-modal__error">{error}</p>
              <div className="twofa-modal__actions">
                <button className="twofa-modal__btn" onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
