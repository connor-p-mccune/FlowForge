import CommentComposer from './CommentComposer'
import { initials, timeAgo } from './commentUtils'

// The popover thread that opens when a comment pin is clicked: every message in
// the thread, a reply box, and a Resolve action. `canResolve` is decided by the
// caller (the comment's author or a workspace owner); the server re-checks it.
export default function CommentThread({ comment, canResolve, onReply, onResolve, onClose }) {
  const messages = comment.replies || []

  return (
    // Stop clicks bubbling to the canvas wrapper so interacting with the thread
    // never places a new comment or dismisses the thread.
    <div className="comment-thread" role="dialog" aria-label="Comment thread" onClick={(e) => e.stopPropagation()}>
      <div className="comment-thread__head">
        <span className="comment-thread__title">Thread</span>
        <div className="comment-thread__head-actions">
          {canResolve && (
            <button
              type="button"
              className="comment-thread__resolve"
              title="Resolve — hides this thread for everyone"
              onClick={() => onResolve(comment.id)}
            >
              ✓ Resolve
            </button>
          )}
          <button type="button" className="comment-thread__close" onClick={onClose} aria-label="Close thread">
            ×
          </button>
        </div>
      </div>

      <div className="comment-thread__messages">
        {messages.map((m) => (
          <div key={m.id} className="comment-msg">
            <span className="comment-msg__avatar" title={m.author_name || ''}>
              {initials(m.author_name)}
            </span>
            <div className="comment-msg__body">
              <div className="comment-msg__meta">
                <span className="comment-msg__author">{m.author_name || 'Unknown'}</span>
                <span className="comment-msg__time">{timeAgo(m.created_at)}</span>
              </div>
              <p className="comment-msg__text">{m.content}</p>
            </div>
          </div>
        ))}
      </div>

      <CommentComposer
        placeholder="Reply…"
        submitLabel="Reply"
        onSubmit={(text) => onReply(comment.id, text)}
      />
    </div>
  )
}
