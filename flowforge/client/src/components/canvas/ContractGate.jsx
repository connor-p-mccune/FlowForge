import { createPortal } from 'react-dom'

// The confirmation shown when deploying would break the workflows that call
// this one.
//
// It is a gate rather than a banner because deploying is the moment the damage
// happens: the version other workflows resolve against changes, and the runs
// that fail afterwards belong to people who did not make this edit and cannot
// see this canvas. A warning somewhere on the page would be a warning somebody
// scrolls past.
//
// It is a *confirmation* and not a refusal for the same reason the CLI gate is
// opt-in: sometimes the right answer is to deploy and fix the callers, and a
// tool that will not let you is a tool people route around. What it must not do
// is let it happen silently.
export default function ContractGate({ report, onCancel, onConfirm }) {
  if (!report) return null
  const broken = report.callers.filter((c) => c.breaks.length > 0)
  const total = broken.reduce((n, c) => n + c.breaks.length, 0)

  return createPortal(
    <div className="import-modal contract-gate-root" role="presentation" onClick={onCancel}>
      <div
        className="import-modal__panel contract-gate"
        role="dialog"
        aria-label="Deploying would break other workflows"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="import-modal__header">
          <h2 className="import-modal__title">
            This breaks {broken.length} other workflow{broken.length === 1 ? '' : 's'}
          </h2>
          <button className="import-modal__close" title="Close" onClick={onCancel}>×</button>
        </header>

        <div className="import-modal__body contract-gate__body">
          <p className="contract-gate__intro">
            {total} reference{total === 1 ? '' : 's'} in{' '}
            {broken.length === 1 ? 'another workflow' : 'other workflows'} read a field this
            version no longer returns. Those runs will not fail — the value will simply arrive
            empty.
          </p>

          <ul className="contract-gate__callers">
            {broken.map((caller) => (
              <li key={caller.workflowId}>
                <span className="contract-gate__caller">{caller.name}</span>
                <ul className="contract-gate__breaks">
                  {caller.breaks.map((b) => (
                    <li key={`${b.nodeId}-${b.path}`}>
                      <code>{`{{${b.reference}}}`}</code>
                      <span className="contract-gate__where"> in {b.label}</span>
                      {b.suggestion && (
                        <span className="contract-gate__hint">
                          {' '}— did you mean <code>{b.suggestion}</code>?
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          {report.change.removed.length > 0 && (
            <p className="contract-gate__change">
              Gone from what this workflow returns:{' '}
              {report.change.removed.map((f) => f.path).join(', ')}
            </p>
          )}
        </div>

        <footer className="contract-gate__footer">
          <button className="contract-gate__cancel" onClick={onCancel}>
            Keep editing
          </button>
          <button className="contract-gate__confirm" onClick={onConfirm}>
            Deploy anyway
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
