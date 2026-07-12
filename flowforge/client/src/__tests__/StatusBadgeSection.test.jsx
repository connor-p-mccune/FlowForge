import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import StatusBadgeSection from '../components/canvas/StatusBadgeSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StatusBadgeSection', () => {
  it('offers to generate a badge when none exists', () => {
    render(<StatusBadgeSection workflowId="wf1" initialToken={null} />)
    expect(screen.getByRole('button', { name: /generate badge/i })).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('mints a token and shows the preview and markdown', async () => {
    apiFetch.mockResolvedValue({ badgeToken: 'tok-123' })
    render(<StatusBadgeSection workflowId="wf1" initialToken={null} />)

    fireEvent.click(screen.getByRole('button', { name: /generate badge/i }))

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/badge-token', { method: 'POST' })
    )
    const img = await screen.findByRole('img', { name: /workflow status badge/i })
    expect(img.getAttribute('src')).toContain('/api/workflows/wf1/badge.svg?token=tok-123')
    expect(screen.getByText(/!\[workflow status\]/)).toBeInTheDocument()
  })

  it('renders the preview immediately when a token is already set', () => {
    render(<StatusBadgeSection workflowId="wf1" initialToken="existing-tok" />)
    const img = screen.getByRole('img', { name: /workflow status badge/i })
    expect(img.getAttribute('src')).toContain('token=existing-tok')
    expect(screen.getByRole('button', { name: /rotate/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove/i })).toBeInTheDocument()
  })

  it('rotating swaps the token in the URL', async () => {
    apiFetch.mockResolvedValue({ badgeToken: 'tok-new' })
    render(<StatusBadgeSection workflowId="wf1" initialToken="tok-old" />)

    fireEvent.click(screen.getByRole('button', { name: /rotate/i }))
    await waitFor(() =>
      expect(screen.getByRole('img').getAttribute('src')).toContain('token=tok-new')
    )
  })

  it('removing clears the badge back to the generate state', async () => {
    apiFetch.mockResolvedValue({})
    render(<StatusBadgeSection workflowId="wf1" initialToken="tok-old" />)

    fireEvent.click(screen.getByRole('button', { name: /remove/i }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/workflows/wf1/badge-token', { method: 'DELETE' })
    )
    expect(await screen.findByRole('button', { name: /generate badge/i })).toBeInTheDocument()
  })

  it('copies the markdown to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.assign(navigator, { clipboard: { writeText } })
    render(<StatusBadgeSection workflowId="wf1" initialToken="tok-1" />)

    fireEvent.click(screen.getByRole('button', { name: /copy markdown/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('/api/workflows/wf1/badge.svg?token=tok-1')
    expect(await screen.findByText('Copied!')).toBeInTheDocument()
  })

  it('surfaces a mint error', async () => {
    apiFetch.mockRejectedValue(new Error('Workflow not found'))
    render(<StatusBadgeSection workflowId="wf1" initialToken={null} />)
    fireEvent.click(screen.getByRole('button', { name: /generate badge/i }))
    expect(await screen.findByText('Workflow not found')).toBeInTheDocument()
  })
})
