import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from 'reactflow'

import CommentComposer from '../components/collaboration/CommentComposer'
import CommentThread from '../components/collaboration/CommentThread'
import CommentsOverlay from '../components/collaboration/CommentsOverlay'
import { initials, timeAgo } from '../components/collaboration/commentUtils'

// CommentsOverlay reads the live viewport via useViewport, so it renders inside a
// flow provider (default transform: zoom 1, pan 0 → pins sit at their raw x/y).
const renderInFlow = (ui) => render(<ReactFlowProvider>{ui}</ReactFlowProvider>)

const comment = (over = {}) => ({
  id: 'c1',
  x: 100,
  y: 50,
  author_id: 'u-owner',
  author_name: 'Olivia Owner',
  replies: [
    { id: 'r1', comment_id: 'c1', author_name: 'Olivia Owner', content: 'Should this be a webhook?', created_at: new Date().toISOString() },
  ],
  ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('commentUtils', () => {
  it('builds up to two initials from a display name', () => {
    expect(initials('Olivia Owner')).toBe('OO')
    expect(initials('Madonna')).toBe('M')
    expect(initials('  ')).toBe('?')
    expect(initials(null)).toBe('?')
  })

  it('formats recent times as "just now"', () => {
    expect(timeAgo(new Date().toISOString())).toBe('just now')
    expect(timeAgo(null)).toBe('')
  })
})

describe('CommentComposer', () => {
  it('submits the trimmed value via the Post button', async () => {
    const onSubmit = vi.fn().mockResolvedValue()
    render(<CommentComposer submitLabel="Post" onSubmit={onSubmit} placeholder="Add a comment…" />)
    const input = screen.getByPlaceholderText('Add a comment…')

    // Disabled until there's content.
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled()

    fireEvent.change(input, { target: { value: '  hello there  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('hello there'))
  })

  it('submits on Enter, not on Shift+Enter, and cancels on Escape', async () => {
    const onSubmit = vi.fn().mockResolvedValue()
    const onCancel = vi.fn()
    render(<CommentComposer onSubmit={onSubmit} onCancel={onCancel} placeholder="Reply…" />)
    const input = screen.getByPlaceholderText('Reply…')

    fireEvent.change(input, { target: { value: 'line one' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('line one'))

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('CommentThread', () => {
  const messages = [
    { id: 'r1', comment_id: 'c1', author_name: 'Olivia Owner', content: 'Opening comment', created_at: new Date().toISOString() },
    { id: 'r2', comment_id: 'c1', author_name: 'Mike Member', content: 'A reply', created_at: new Date().toISOString() },
  ]

  it('renders every message with its author and content', () => {
    render(
      <CommentThread comment={comment({ replies: messages })} canResolve={false} onReply={vi.fn()} onResolve={vi.fn()} onClose={vi.fn()} />
    )
    expect(screen.getByText('Opening comment')).toBeInTheDocument()
    expect(screen.getByText('A reply')).toBeInTheDocument()
    expect(screen.getByText('Mike Member')).toBeInTheDocument()
  })

  it('shows Resolve only when allowed, and forwards the comment id', () => {
    const onResolve = vi.fn()
    const { rerender } = render(
      <CommentThread comment={comment()} canResolve={false} onReply={vi.fn()} onResolve={onResolve} onClose={vi.fn()} />
    )
    expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument()

    rerender(
      <CommentThread comment={comment()} canResolve onReply={vi.fn()} onResolve={onResolve} onClose={vi.fn()} />
    )
    fireEvent.click(screen.getByRole('button', { name: /resolve/i }))
    expect(onResolve).toHaveBeenCalledWith('c1')
  })

  it('posts a reply through the composer with the comment id', async () => {
    const onReply = vi.fn().mockResolvedValue()
    render(<CommentThread comment={comment()} canResolve={false} onReply={onReply} onResolve={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText('Reply…'), { target: { value: 'on it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    await waitFor(() => expect(onReply).toHaveBeenCalledWith('c1', 'on it'))
  })
})

describe('CommentsOverlay', () => {
  const baseProps = {
    draft: null,
    openCommentId: null,
    viewerIsOwner: false,
    currentUser: { id: 'u-owner', displayName: 'Olivia Owner' },
    onOpenThread: vi.fn(),
    onCloseThread: vi.fn(),
    onSubmitDraft: vi.fn(),
    onCancelDraft: vi.fn(),
    onReply: vi.fn(),
    onResolve: vi.fn(),
  }

  it('renders a pin with the author initials and opens the thread on click', () => {
    const onOpenThread = vi.fn()
    const { container } = renderInFlow(
      <CommentsOverlay {...baseProps} comments={[comment()]} onOpenThread={onOpenThread} />
    )
    const pin = container.querySelector('.comment-pin')
    expect(pin).toHaveTextContent('OO')
    // One reply (the opening comment) → no extra-replies chip.
    expect(container.querySelector('.comment-pin__count')).toBeNull()

    fireEvent.click(pin)
    expect(onOpenThread).toHaveBeenCalledWith('c1')
  })

  it('shows a reply-count chip for additional replies', () => {
    const withReplies = comment({
      replies: [
        { id: 'r1', comment_id: 'c1', author_name: 'Olivia Owner', content: 'one', created_at: new Date().toISOString() },
        { id: 'r2', comment_id: 'c1', author_name: 'Mike Member', content: 'two', created_at: new Date().toISOString() },
        { id: 'r3', comment_id: 'c1', author_name: 'Mike Member', content: 'three', created_at: new Date().toISOString() },
      ],
    })
    const { container } = renderInFlow(<CommentsOverlay {...baseProps} comments={[withReplies]} />)
    expect(container.querySelector('.comment-pin__count')).toHaveTextContent('2')
  })

  it('renders the open thread for the matching comment', () => {
    const { container } = renderInFlow(
      <CommentsOverlay {...baseProps} comments={[comment()]} openCommentId="c1" />
    )
    expect(container.querySelector('.comment-thread')).toBeInTheDocument()
    expect(screen.getByText('Should this be a webhook?')).toBeInTheDocument()
  })

  it('renders the draft composer and submits a new comment', async () => {
    const onSubmitDraft = vi.fn().mockResolvedValue()
    renderInFlow(
      <CommentsOverlay {...baseProps} comments={[]} draft={{ x: 10, y: 20 }} onSubmitDraft={onSubmitDraft} />
    )
    fireEvent.change(screen.getByPlaceholderText('Add a comment…'), { target: { value: 'first note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Post' }))
    await waitFor(() => expect(onSubmitDraft).toHaveBeenCalledWith('first note'))
  })
})
