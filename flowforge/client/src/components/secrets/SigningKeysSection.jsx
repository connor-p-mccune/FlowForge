import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// The workspace trust store: which Ed25519 keys this workspace will accept a
// workflow definition from.
//
// It sits on the Secrets page because both are key material an owner manages,
// and because the whole section is owner-only — a non-owner's fetch is refused
// and the section simply does not appear, the same way the encryption key ring
// above it behaves.
//
// Two pieces of copy are load-bearing rather than decorative. The **enforcement
// toggle is explicitly only about unsigned imports**, because the thing people
// assume otherwise is that turning it off means a broken signature is tolerated
// — it never is, and a UI that left that ambiguous would make the whole feature
// decorative. And **revoked keys stay listed**, because the question after an
// incident is what a key signed *while* it was trusted, so hiding the row would
// answer it with silence.

const formatDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SigningKeysSection({ workspaceId }) {
  const toast = useToast()
  const [state, setState] = useState(null) // null = loading or not an owner
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setState(await apiFetch(`/api/workspaces/${workspaceId}/signing-keys`))
    } catch {
      // Members and viewers are refused, which is not an error worth showing —
      // the trust store is an owner's concern end to end.
      setState(null)
    }
  }, [workspaceId])

  useEffect(() => {
    load()
  }, [load])

  async function add(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/workspaces/${workspaceId}/signing-keys`, {
        method: 'POST',
        body: { name: name.trim(), publicKey },
      })
      toast.success(
        res.reinstated ? `Re-trusted ${res.key.name}.` : `Now trusting ${res.key.name}.`
      )
      setName('')
      setPublicKey('')
      setAdding(false)
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(key) {
    setBusy(true)
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/signing-keys/${key.id}`, { method: 'DELETE' })
      toast.success(`Revoked ${key.name}. Definitions it signed are no longer trusted.`)
      await load()
    } catch (err) {
      toast.error(`Couldn’t revoke: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function setEnforcement(required) {
    setBusy(true)
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/signing-keys/enforcement`, {
        method: 'PUT',
        body: { requireSignedImports: required },
      })
      toast.success(
        required
          ? 'Unsigned imports are now refused.'
          : 'Unsigned imports are allowed again.'
      )
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  const keys = state.keys || []
  const active = keys.filter((k) => k.active)

  return (
    <section className="signing-keys" aria-label="Signing keys">
      <h2 className="signing-keys__title">Signing keys</h2>
      <p className="secrets-page__hint">
        A workflow definition can travel with an Ed25519 signature, and these are
        the keys this workspace accepts one from. It answers the question a
        promotion otherwise leaves open — <em>is the graph that arrived the graph
        that was reviewed?</em> — since between the approval and the import the
        document passes through a repository, a runner and an HTTP call.
      </p>
      <p className="secrets-page__hint">
        Mint a pair with <code>flowforge keygen</code>, which never touches a
        server, and paste the <code>.pub</code> half here. The signature covers
        what the workflow <em>does</em> — node config, wiring, declared
        guarantees — not the file’s layout, so a re-export after somebody moves a
        node still verifies.
      </p>

      {error && <p className="secrets-page__error">{error}</p>}

      <label className="signing-keys__enforce">
        <input
          type="checkbox"
          checked={Boolean(state.requireSignedImports)}
          disabled={busy || (active.length === 0 && !state.requireSignedImports)}
          onChange={(e) => setEnforcement(e.target.checked)}
        />
        <span>
          Refuse <strong>unsigned</strong> imports
          <span className="secrets-page__hint">
            Only the unsigned case. A signature that fails to verify is refused
            whether or not this is on — that is evidence the document changed
            after it was signed, and there is no setting under which the right
            answer is to import it anyway.
            {active.length === 0 && !state.requireSignedImports && (
              <> Trust a key first, or this would lock out your own promotions.</>
            )}
          </span>
        </span>
      </label>

      {keys.length === 0 ? (
        <p className="secrets-page__hint">
          No keys trusted yet, so every import is unsigned and recorded as such.
        </p>
      ) : (
        <ul className="signing-keys__list">
          {keys.map((key) => (
            <li
              className={`signing-keys__item${key.active ? '' : ' signing-keys__item--revoked'}`}
              key={key.id}
            >
              <div className="signing-keys__meta">
                <span className="signing-keys__name">{key.name}</span>
                {!key.active && (
                  <span className="signing-keys__badge">revoked {formatDate(key.revokedAt)}</span>
                )}
                <code className="signing-keys__print">{key.fingerprint}</code>
                <span className="secrets-page__hint">
                  Added {formatDate(key.createdAt)}
                  {key.addedBy ? ` by ${key.addedBy}` : ''}
                </span>
              </div>
              {key.active && (
                <button
                  className="secrets-page__btn"
                  onClick={() => revoke(key)}
                  disabled={busy}
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form className="signing-keys__add" onSubmit={add}>
          <label className="secrets-page__field">
            <span>Name</span>
            <input
              value={name}
              placeholder="release key"
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="secrets-page__field secrets-page__field--grow">
            <span>Public key (PEM)</span>
            <textarea
              className="signing-keys__pem"
              value={publicKey}
              rows={4}
              placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
              onChange={(e) => setPublicKey(e.target.value)}
            />
          </label>
          <div className="signing-keys__actions">
            <button
              className="secrets-page__btn secrets-page__btn--primary"
              type="submit"
              disabled={busy || !name.trim() || !publicKey.trim()}
            >
              {busy ? 'Trusting…' : 'Trust this key'}
            </button>
            <button className="secrets-page__btn" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="secrets-page__btn" onClick={() => setAdding(true)}>
          + Trust a key
        </button>
      )}
    </section>
  )
}
