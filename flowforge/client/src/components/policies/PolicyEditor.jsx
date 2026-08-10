import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../../services/api'

// Author a policy, and — the point of the component — **test it before saving**.
//
// Pick a workflow, and the rule is evaluated against that workflow's real policy
// document: does it hold, and if not, what evidence does it report? A governance
// rule written blind is how a workspace discovers at 6pm on a Friday that every
// deploy is refused, so the try-it panel is not a nicety here.
//
// The document is shown alongside, because a rule is written *about* it and
// nobody remembers thirty field names. It is the same reasoning as the
// expression playground: the authoring surface should compute exactly what the
// enforcing surface will.

const SEVERITIES = [
  { value: 'deny', label: 'Deny — refuse the deploy' },
  { value: 'warn', label: 'Warn — record it and let it through' },
]

export default function PolicyEditor({ workspaceId, policy, onSaved, onCancel }) {
  const [name, setName] = useState(policy.name || '')
  const [description, setDescription] = useState(policy.description || '')
  const [rule, setRule] = useState(policy.rule || '')
  const [message, setMessage] = useState(policy.message || '')
  const [evidence, setEvidence] = useState(policy.evidence || '')
  const [severity, setSeverity] = useState(policy.severity || 'deny')

  const [workflows, setWorkflows] = useState([])
  const [tryAgainst, setTryAgainst] = useState('')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [showDocument, setShowDocument] = useState(false)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/workspaces/${workspaceId}/workflows`)
      .then(({ workflows: list }) => {
        if (cancelled) return
        setWorkflows(list)
        setTryAgainst((current) => current || list[0]?.id || '')
      })
      .catch(() => setWorkflows([]))
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const runPreview = useCallback(async () => {
    if (!tryAgainst || !rule.trim()) return
    setPreviewing(true)
    try {
      const result = await apiFetch(`/api/workspaces/${workspaceId}/policies/evaluate`, {
        method: 'POST',
        body: { workflowId: tryAgainst, rule, evidence: evidence || undefined },
      })
      setPreview(result)
    } catch (err) {
      setPreview({ ok: false, error: err.message })
    } finally {
      setPreviewing(false)
    }
  }, [workspaceId, tryAgainst, rule, evidence])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveError(null)
    const body = { name, description, rule, message, evidence, severity }
    try {
      const path = policy.id
        ? `/api/workspaces/${workspaceId}/policies/${policy.id}`
        : `/api/workspaces/${workspaceId}/policies`
      const { policy: saved } = await apiFetch(path, {
        method: policy.id ? 'PUT' : 'POST',
        body,
      })
      onSaved(saved)
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const canSave = name.trim() !== '' && rule.trim() !== '' && !saving

  return (
    <form className="policy-editor" onSubmit={handleSave}>
      <div className="policy-editor__grid">
        <label className="secrets-page__field secrets-page__field--grow">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="secrets-page__field">
          <span>Severity</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="secrets-page__field secrets-page__field--grow">
        <span>Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Why this rule exists"
        />
      </label>

      <label className="secrets-page__field secrets-page__field--grow">
        <span>
          Rule <em>— must evaluate true for a workflow to comply</em>
        </span>
        <textarea
          className="policy-editor__code"
          rows={2}
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          placeholder='len(notMatching(httpHosts, ["*.example.com"])) == 0'
        />
      </label>

      <label className="secrets-page__field secrets-page__field--grow">
        <span>
          Message <em>— shown to whoever is blocked, so make it the remedy</em>
        </span>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          placeholder="Route this call through an approved host."
        />
      </label>

      <label className="secrets-page__field secrets-page__field--grow">
        <span>
          Evidence <em>— optional; evaluated only on failure, to show what tripped it</em>
        </span>
        <textarea
          className="policy-editor__code"
          rows={1}
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder='notMatching(httpHosts, ["*.example.com"])'
        />
      </label>

      <div className="policy-editor__try">
        <div className="policy-editor__try-head">
          <strong>Try it</strong>
          <select value={tryAgainst} onChange={(e) => setTryAgainst(e.target.value)}>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secrets-page__btn"
            onClick={runPreview}
            disabled={previewing || !rule.trim() || !tryAgainst}
          >
            {previewing ? 'Checking…' : 'Check'}
          </button>
          {preview?.document && (
            <button
              type="button"
              className="secrets-page__btn"
              onClick={() => setShowDocument((v) => !v)}
            >
              {showDocument ? 'Hide fields' : 'Show available fields'}
            </button>
          )}
        </div>

        {preview && !preview.ok && (
          <p className="policy-editor__result policy-editor__result--error">{preview.error}</p>
        )}
        {preview?.ok && (
          <p
            className={`policy-editor__result policy-editor__result--${
              preview.holds ? 'pass' : 'fail'
            }`}
          >
            {preview.holds
              ? 'Holds — this workflow complies.'
              : `Does not hold — this workflow would be ${
                  severity === 'deny' ? 'blocked' : 'flagged'
                }.`}
            {preview.evidence != null && (
              <> Evidence: <code>{JSON.stringify(preview.evidence)}</code></>
            )}
          </p>
        )}
        {showDocument && preview?.document && (
          <pre className="policy-editor__document">{JSON.stringify(preview.document, null, 2)}</pre>
        )}
      </div>

      {saveError && <p className="secrets-page__error">{saveError}</p>}

      <div className="policy-editor__buttons">
        <button className="secrets-page__btn secrets-page__btn--primary" type="submit" disabled={!canSave}>
          {saving ? 'Saving…' : policy.id ? 'Save changes' : 'Create policy'}
        </button>
        <button type="button" className="secrets-page__btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
