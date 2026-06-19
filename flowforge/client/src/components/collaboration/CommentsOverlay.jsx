import { useViewport } from 'reactflow'
import CommentComposer from './CommentComposer'
import CommentThread from './CommentThread'
import { initials } from './commentUtils'

// Renders comment pins, the open thread, and the new-comment draft composer as an
// overlay above the canvas. Like CursorOverlay, it converts each stored
// flow-coordinate (x, y) to a screen position using the live viewport transform
// (screen = flow * zoom + pan), so pins track the canvas as it pans and zooms.
//
// The overlay container is pointer-events:none so empty space falls through to
// React Flow (which fires onPaneClick / onPaneContextMenu to place comments); the
// pins, composer, and thread re-enable pointer events on themselves.
export default function CommentsOverlay({
  comments,
  draft,
  openCommentId,
  viewerIsOwner,
  currentUser,
  onOpenThread,
  onCloseThread,
  onSubmitDraft,
  onCancelDraft,
  onReply,
  onResolve,
}) {
  const { x: vx, y: vy, zoom } = useViewport()
  const toScreen = (x, y) => ({ left: x * zoom + vx, top: y * zoom + vy })

  return (
    <div className="comments-overlay">
      {comments.map((comment) => {
        const isOpen = comment.id === openCommentId
        // The opening comment is the first reply, so "replies" past it = length - 1.
        const replyCount = Math.max(0, (comment.replies?.length || 0) - 1)
        return (
          <div key={comment.id} className="comment-pin-wrap" style={toScreen(comment.x, comment.y)}>
            <button
              type="button"
              className={`comment-pin${isOpen ? ' comment-pin--open' : ''}${
                comment.author_id === currentUser?.id ? ' comment-pin--own' : ''
              }`}
              title={`${comment.author_name || 'Someone'}${replyCount ? ` · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}` : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (isOpen) onCloseThread()
                else onOpenThread(comment.id)
              }}
            >
              <span className="comment-pin__initials">{initials(comment.author_name)}</span>
              {replyCount > 0 && <span className="comment-pin__count">{replyCount}</span>}
            </button>
            {isOpen && (
              <CommentThread
                comment={comment}
                canResolve={viewerIsOwner || comment.author_id === currentUser?.id}
                onReply={onReply}
                onResolve={onResolve}
                onClose={onCloseThread}
              />
            )}
          </div>
        )
      })}

      {draft && (
        <div className="comment-pin-wrap" style={toScreen(draft.x, draft.y)}>
          <span className="comment-pin comment-pin--draft" aria-hidden="true">
            <span className="comment-pin__initials">{initials(currentUser?.displayName)}</span>
          </span>
          <div className="comment-thread comment-thread--draft" onClick={(e) => e.stopPropagation()}>
            <CommentComposer
              autoFocus
              placeholder="Add a comment…"
              submitLabel="Post"
              onSubmit={onSubmitDraft}
              onCancel={onCancelDraft}
            />
          </div>
        </div>
      )}
    </div>
  )
}
