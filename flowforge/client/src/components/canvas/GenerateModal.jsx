import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

// Prompt chips that fill the textarea on click — concrete examples cover the
// breadth of what the generator handles (webhook + condition, schedule + email,
// AI classify/route, AI extract + HTTP).
const EXAMPLE_PROMPTS = [
  'Send a Slack message when a webhook fires with a payment over $100',
  'Every Monday morning fetch our sales data and email me a summary',
  'Classify incoming support tickets and route urgent ones to Slack',
  'When a webhook receives a new signup, extract the name and email and add them to our CRM',
]

// Centered modal: describe a workflow in plain English and let the AI build it.
// Mirrors ImportWorkflowModal's portal + Escape-to-close pattern. The parent owns
// the API call (so the toolbar sparkle can animate too) and applies the resulting
// graph; when the canvas already has nodes it flips `confirmReplace` and we ask
// before overwriting.
export default function GenerateModal({
  generating,
  error,
  confirmReplace,
  onSubmit,
  onConfirmReplace,
  onCancelReplace,
  onClose,
}) {
  const [prompt, setPrompt] = useState('')

  // Close on Escape, but never mid-generation (avoid orphaning the request).
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !generating) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, generating])

  const handleSubmit = useCallback(() => {
    const trimmed = prompt.trim()
    if (!trimmed || generating) return
    onSubmit(trimmed)
  }, [prompt, generating, onSubmit])

  return createPortal(
    <div
      className="generate-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Generate workflow with AI"
      onClick={generating ? undefined : onClose}
    >
      <div className="generate-modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="generate-modal__header">
          <h2 className="generate-modal__title">✨ Generate workflow with AI</h2>
          <button
            className="generate-modal__close"
            title="Close"
            onClick={onClose}
            disabled={generating}
          >
            ×
          </button>
        </header>

        {confirmReplace ? (
          <>
            <div className="generate-modal__body">
              <p className="generate-modal__confirm">
                This will replace your current canvas. Continue?
              </p>
            </div>
            <footer className="generate-modal__actions">
              <button className="generate-modal__btn" onClick={onCancelReplace}>
                Cancel
              </button>
              <button
                className="generate-modal__btn generate-modal__btn--primary"
                onClick={onConfirmReplace}
              >
                Replace canvas
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="generate-modal__body">
              <textarea
                className="generate-modal__textarea"
                placeholder="Describe your workflow…  e.g. notify me on Slack when a webhook receives a payment over $100"
                value={prompt}
                maxLength={2000}
                rows={5}
                autoFocus
                disabled={generating}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits, like other "send" textareas.
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleSubmit()
                }}
              />

              <div className="generate-modal__examples">
                {EXAMPLE_PROMPTS.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    className="generate-modal__chip"
                    disabled={generating}
                    onClick={() => setPrompt(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>

              {error && <p className="generate-modal__error">{error}</p>}
            </div>

            <footer className="generate-modal__actions">
              <button className="generate-modal__btn" onClick={onClose} disabled={generating}>
                Cancel
              </button>
              <button
                className="generate-modal__btn generate-modal__btn--primary"
                onClick={handleSubmit}
                disabled={!prompt.trim() || generating}
              >
                <span
                  className={`generate-modal__sparkle${generating ? ' generate-modal__sparkle--spin' : ''}`}
                  aria-hidden="true"
                >
                  ✨
                </span>
                {generating ? 'Generating…' : 'Generate'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
