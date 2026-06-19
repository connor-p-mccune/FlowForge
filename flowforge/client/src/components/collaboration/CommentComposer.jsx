import { useState } from 'react'

// Small text input shared by the new-comment draft and the in-thread reply box.
// Enter submits (Shift+Enter inserts a newline); Escape cancels when cancellable.
// onSubmit may be async — the input stays disabled until it settles, then clears.
export default function CommentComposer({
  autoFocus = false,
  placeholder = 'Add a comment…',
  submitLabel = 'Post',
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    const text = value.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      await onSubmit(text)
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="comment-composer">
      <textarea
        className="comment-composer__input"
        rows={2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="comment-composer__actions">
        {onCancel && (
          <button
            type="button"
            className="comment-composer__btn comment-composer__btn--cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          className="comment-composer__btn comment-composer__btn--submit"
          onClick={submit}
          disabled={busy || !value.trim()}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  )
}
