import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../services/api'
import { useToast } from '../../hooks/useToast'

// Micro-USD → a string. Mirrors the server's formatMicroUsd deliberately rather
// than trusting only the pre-formatted `display` field, because the budget
// figures (cap, remaining) are computed here from raw integers and must render
// the same way the breakdown rows do.
export function formatUsd(microUsd) {
  const value = Number(microUsd) || 0
  if (value === 0) return '$0.00'
  const usd = value / 1_000_000
  if (usd < 0.0001) return '<$0.0001'
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

const GROUPINGS = [
  { key: 'workflow', label: 'By workflow' },
  { key: 'nodeType', label: 'By node type' },
  { key: 'day', label: 'By day' },
]

// The budget meter. Three states, and the copy changes with them, because
// "80% used" and "blocked" call for different actions and a single bar colour
// wouldn't say which one you're in.
function BudgetMeter({ budget, onEdit, canEdit }) {
  if (!budget) return null

  if (budget.capMicroUsd == null) {
    return (
      <div className="cost__budget cost__budget--none">
        <div>
          <strong>{formatUsd(budget.spentMicroUsd)}</strong> spent in {budget.month} · no budget set
        </div>
        {canEdit && (
          <button className="cost__budget-edit" onClick={onEdit}>
            Set a budget
          </button>
        )}
      </div>
    )
  }

  const pct = Math.min(100, Math.round((budget.usedFraction || 0) * 100))
  const state = budget.blocked ? 'blocked' : pct >= (budget.alertPct || 0.8) * 100 ? 'warn' : 'ok'

  return (
    <div className={`cost__budget cost__budget--${state}`}>
      <div className="cost__budget-head">
        <div>
          <strong>{formatUsd(budget.spentMicroUsd)}</strong> of{' '}
          {formatUsd(budget.capMicroUsd)} · {budget.month}
        </div>
        {canEdit && (
          <button className="cost__budget-edit" onClick={onEdit}>
            Change
          </button>
        )}
      </div>
      <div className="cost__budget-bar">
        <div className="cost__budget-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="cost__budget-note">
        {budget.blocked
          ? 'Budget reached — new runs are being refused. In-flight runs finish, and dry runs still work.'
          : `${pct}% used · ${formatUsd(budget.capMicroUsd - budget.spentMicroUsd)} left this month`}
      </div>
    </div>
  )
}

// Workspace spend: what the month has cost, against the cap, broken down.
//
// Reading is open to every member — knowing what the workflows you build cost
// is part of building them well — while only an owner can change the cap, which
// is why the edit control is gated rather than the whole section.
export default function CostSection({ workspaceId, canEdit = false }) {
  const [groupBy, setGroupBy] = useState('workflow')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [capInput, setCapInput] = useState('')
  const toast = useToast()

  const load = useCallback(
    async (grouping) => {
      try {
        const result = await apiFetch(
          `/api/workspaces/${workspaceId}/costs?groupBy=${grouping}`
        )
        setData(result)
        setError(null)
      } catch (err) {
        setError(err.message)
      }
    },
    [workspaceId]
  )

  useEffect(() => {
    load(groupBy)
  }, [load, groupBy])

  async function saveBudget(e) {
    e.preventDefault()
    const trimmed = capInput.trim()
    try {
      await apiFetch(`/api/workspaces/${workspaceId}/budget`, {
        method: 'PUT',
        // An empty field removes the budget rather than setting it to zero —
        // zero would mean "block everything", which nobody types by accident
        // but everyone would hit by clearing the box.
        body: { capUsd: trimmed === '' ? null : Number(trimmed) },
      })
      toast.success(trimmed === '' ? 'Budget removed' : `Budget set to $${trimmed}`)
      setEditing(false)
      load(groupBy)
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (error) {
    return <div className="cost__error">Unable to load costs — {error}</div>
  }
  if (!data) return null

  const unpricedNote =
    groupBy === 'nodeType' && data.breakdown.some((r) => r.key === 'action-http')
      ? 'External calls are counted but not priced — FlowForge can’t know what a third-party API charges. Set a per-call cost on the node to include it.'
      : null

  return (
    <div className="analytics__panel cost">
      <div className="analytics__panel-title">Spend</div>

      <BudgetMeter
        budget={data.budget}
        canEdit={canEdit}
        onEdit={() => {
          setCapInput(
            data.budget?.capMicroUsd ? String(data.budget.capMicroUsd / 1_000_000) : ''
          )
          setEditing(true)
        }}
      />

      {editing && (
        <form className="cost__budget-form" onSubmit={saveBudget}>
          <label>
            <span>Monthly cap (USD)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Leave empty for no budget"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              aria-label="Monthly budget cap in USD"
            />
          </label>
          <div className="cost__budget-actions">
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="cost__groupings" role="group" aria-label="Group spend by">
        {GROUPINGS.map((g) => (
          <button
            key={g.key}
            className={`analytics__range-btn${groupBy === g.key ? ' analytics__range-btn--active' : ''}`}
            onClick={() => setGroupBy(g.key)}
          >
            {g.label}
          </button>
        ))}
      </div>

      {data.breakdown.length === 0 ? (
        <p className="cost__empty">
          Nothing metered this month. Cost is recorded for AI steps (priced from token
          usage) and for external calls you’ve given a rate.
        </p>
      ) : (
        <table className="cost__table">
          <thead>
            <tr>
              <th scope="col">{groupBy === 'day' ? 'Day' : groupBy === 'nodeType' ? 'Node type' : 'Workflow'}</th>
              <th scope="col">{groupBy === 'nodeType' ? 'Steps' : 'Runs'}</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.breakdown.map((row) => (
              <tr key={row.key}>
                <td>{row.name || row.key}</td>
                <td className="cost__num">{row.runs ?? row.steps ?? 0}</td>
                <td className="cost__num">{row.display}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td />
              <td className="cost__num">{formatUsd(data.total)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {unpricedNote && <p className="cost__note">{unpricedNote}</p>}
    </div>
  )
}
