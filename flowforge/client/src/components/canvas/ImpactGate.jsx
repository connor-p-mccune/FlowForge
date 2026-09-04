import { createPortal } from 'react-dom'

// What this deploy *means*, shown at the moment it would happen.
//
// The canvas already gates a deploy that would break the workflows calling this
// one. This gates the other half: what the edit does to the properties of *this*
// workflow — the approval that is no longer in front of the payment, the step
// that stopped being safe to retry, the guarantee that no longer holds.
//
// It is a gate rather than a panel because the change that most needs saying is
// the one that looks like nothing. Deleting an edge and drawing a new one is two
// gestures and no visible difference on a canvas of forty nodes, and a banner
// somewhere on the page is a banner somebody scrolls past on the way to the
// button they already decided to press.
//
// A **confirmation** and not a refusal, for the same reason the CLI's tier is
// not a failure by default: an ungated payment is sometimes exactly what
// somebody meant, and a tool that will not let you is a tool people route
// around. What it must not do is let it happen silently.
//
// It shows what the change *fixes* too. A reviewer told only about the bad half
// cannot tell a refactor from a regression, and somebody who has just gated
// three effects deserves to see that before being asked to confirm.

const TONE = {
  'ungated-effect': 'impact-gate__finding--severe',
  'guarantee-broken': 'impact-gate__finding--severe',
  'lint-error': 'impact-gate__finding--severe',
}

export default function ImpactGate({ report, onCancel, onConfirm }) {
  if (!report) return null
  const { findings, resolved, nodes, summary } = report

  return createPortal(
    <div className="import-modal impact-gate-root" role="presentation" onClick={onCancel}>
      <div
        className="import-modal__panel impact-gate"
        role="dialog"
        aria-label="What this change means"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="import-modal__header">
          <h2 className="import-modal__title">
            This change alters what the workflow guarantees
          </h2>
          <button className="import-modal__close" title="Close" onClick={onCancel}>
            ×
          </button>
        </header>

        <div className="import-modal__body impact-gate__body">
          <p className="impact-gate__intro">
            {summary.introduced} thing{summary.introduced === 1 ? '' : 's'} changed about what a
            run of this workflow can do. None of it is a syntax error, and most of it will not
            show up in a diff.
          </p>

          <ul className="impact-gate__findings">
            {findings.map((f) => (
              <li key={`${f.code}:${f.subject}`} className={TONE[f.code] || ''}>
                <span className="impact-gate__summary">{f.summary}</span>
                <span className="impact-gate__detail">{f.detail}</span>
                {/* A finding another gate already refuses is a different kind
                    of news: the deploy is going to be stopped whether or not
                    this dialog is confirmed. */}
                {f.blocking && (
                  <span className="impact-gate__blocking">the deploy check refuses this anyway</span>
                )}
              </li>
            ))}
          </ul>

          {resolved.length > 0 && (
            <>
              <h3 className="impact-gate__section">What it fixes</h3>
              <ul className="impact-gate__resolved">
                {resolved.map((r) => (
                  <li key={`${r.code}:${r.subject}`}>{r.summary}</li>
                ))}
              </ul>
            </>
          )}

          {nodes.added.length > 0 && nodes.removed.length > 0 && (
            <p className="impact-gate__note">
              {nodes.added.length} node{nodes.added.length === 1 ? '' : 's'} added and{' '}
              {nodes.removed.length} removed — anything listed as both fixed and introduced may be
              one node redrawn.
            </p>
          )}
        </div>

        <footer className="import-modal__footer">
          <button className="btn btn--ghost" onClick={onCancel}>
            Keep editing
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            Deploy anyway
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
