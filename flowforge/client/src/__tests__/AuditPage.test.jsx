import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../services/api', () => ({ apiFetch: vi.fn(), apiFetchText: vi.fn() }))

import AuditPage from '../components/audit/AuditPage'
import { describeAuditEntry, formatAuditTime } from '../components/audit/format'
import { ToastProvider } from '../hooks/useToast'
import { apiFetch } from '../services/api'

const entry = (over = {}) => ({
  id: `e${over.seq ?? 1}`,
  seq: 1,
  action: 'secret.created',
  actor: 'Ada',
  targetType: 'secret',
  targetId: 'API_KEY',
  targetName: 'API_KEY',
  metadata: null,
  createdAt: '2026-08-05T14:32:07.000Z',
  prevHash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  ...over,
})

// Route responses by URL so the page's parallel list + verify calls each get
// the right shape regardless of which resolves first.
function mockApi({ entries = [entry()], hasMore = false, verification } = {}) {
  apiFetch.mockImplementation((url) => {
    if (url.includes('/audit/verify')) {
      return Promise.resolve(
        verification || { ok: true, entries: entries.length, head: 'c'.repeat(64), brokenAt: null }
      )
    }
    if (url.includes('/audit')) return Promise.resolve({ entries, hasMore })
    return Promise.resolve({})
  })
}

const setup = () =>
  render(
    <ToastProvider>
      <AuditPage workspaceId="ws1" />
    </ToastProvider>
  )

describe('describeAuditEntry', () => {
  it('renders each action as a past-tense sentence naming the target', () => {
    expect(describeAuditEntry(entry({ action: 'secret.deleted' }))).toBe(
      'deleted the secret API_KEY'
    )
    expect(
      describeAuditEntry(
        entry({ action: 'member.role_changed', targetName: 'Ada', metadata: { from: 'viewer', to: 'owner' } })
      )
    ).toBe('changed Ada’s role from viewer to owner')
    expect(
      describeAuditEntry(
        entry({ action: 'token.minted', targetName: 'ci', metadata: { scopes: ['read', 'trigger'] } })
      )
    ).toBe('minted the API token “ci” (read, trigger)')
    expect(
      describeAuditEntry(entry({ action: 'workflow.deployed', targetName: 'Sync', metadata: { version: 4 } }))
    ).toBe('deployed Sync as version 4')
  })

  it('falls back honestly for an action this build does not know', () => {
    // A newer server must not render a blank cell.
    expect(describeAuditEntry(entry({ action: 'future.thing', targetName: 'X' }))).toBe(
      'future.thing · X'
    )
  })
})

describe('formatAuditTime', () => {
  it('renders an absolute UTC instant to the second, not a relative time', () => {
    expect(formatAuditTime('2026-08-05T14:32:07.000Z')).toBe('2026-08-05 14:32:07 UTC')
  })
})

describe('AuditPage', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('shows the verified banner with the entry count and head hash', async () => {
    mockApi({ entries: [entry(), entry({ seq: 2, action: 'secret.deleted' })] })
    setup()
    expect(await screen.findByText(/Chain verified — 2 entries, unbroken/)).toBeInTheDocument()
    expect(screen.getByText(/head cccccccccccccccc/)).toBeInTheDocument()
  })

  it('renders entries as a table with their sequence numbers', async () => {
    mockApi({ entries: [entry({ seq: 7, action: 'member.removed', targetName: 'Mallory' })] })
    setup()
    expect(await screen.findByText('removed Mallory from the workspace')).toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('raises a loud alert when the chain is broken', async () => {
    mockApi({
      verification: {
        ok: false,
        entries: 5,
        head: null,
        brokenAt: { seq: 3, id: 'e3', reason: 'hash-mismatch', detail: 'contents changed' },
      },
    })
    setup()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Chain verification failed/)
    expect(alert).toHaveTextContent(/Entry #3/)
    expect(alert).toHaveTextContent(/modified outside the application/)
  })

  it('explains the refusal rather than showing an error when the user is not an owner', async () => {
    apiFetch.mockRejectedValue(new Error('Only workspace owners can read the audit log'))
    setup()
    expect(await screen.findByText('Owners only')).toBeInTheDocument()
    expect(screen.queryByText(/Unable to load/)).not.toBeInTheDocument()
  })

  it('filters by action family through the API', async () => {
    mockApi()
    setup()
    await screen.findByText(/Chain verified/)
    fireEvent.click(screen.getByRole('button', { name: 'Members' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('action=member.*'))
    )
  })
})
