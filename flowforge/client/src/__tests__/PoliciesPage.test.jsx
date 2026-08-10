import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PoliciesPage from '../components/policies/PoliciesPage'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
vi.mock('../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

const POLICY = {
  id: 'p1',
  name: 'Approved hosts',
  description: 'Only call vetted integrations.',
  rule: 'len(notMatching(httpHosts, ["*.acme.com"])) == 0',
  message: 'Call an approved host.',
  evidence: 'notMatching(httpHosts, ["*.acme.com"])',
  severity: 'deny',
  enabled: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
}

const TEMPLATES = [
  {
    key: 'https-only',
    name: 'Outbound calls must use HTTPS',
    description: 'Every HTTP node must address an https:// URL.',
    rule: 'len(notMatching(outboundUrls, ["https://*"])) == 0',
    message: 'Use https://.',
    severity: 'deny',
  },
]

function routeFetch(overrides = {}) {
  apiFetch.mockImplementation((path, options) => {
    if (path.endsWith('/policies') && !options) return Promise.resolve({ policies: [POLICY] })
    if (path === '/api/policy-templates') return Promise.resolve({ templates: TEMPLATES })
    if (path.endsWith('/workflows')) return Promise.resolve({ workflows: [{ id: 'wf-1', name: 'Sync' }] })
    if (path.endsWith('/policies/evaluate')) {
      return Promise.resolve(
        overrides.evaluate || { ok: true, holds: false, evidence: ['evil.net'], document: { httpHosts: [] } }
      )
    }
    if (options?.method === 'PUT') {
      return Promise.resolve({ policy: { ...POLICY, ...options.body, id: POLICY.id } })
    }
    if (options?.method === 'POST') return Promise.resolve({ policy: { ...POLICY, ...options.body } })
    if (options?.method === 'DELETE') return Promise.resolve({ deleted: true })
    return Promise.resolve({})
  })
}

describe('PoliciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    routeFetch()
  })

  it('lists a workspace’s policies with their severity and rule', async () => {
    render(<PoliciesPage workspaceId="ws-1" />)
    expect(await screen.findByText('Approved hosts')).toBeInTheDocument()
    expect(screen.getByText('deny', { selector: '.policy-badge' })).toBeInTheDocument()
    expect(screen.getByText(/notMatching\(httpHosts/)).toBeInTheDocument()
  })

  it('says plainly whether anything can currently block a deploy', async () => {
    render(<PoliciesPage workspaceId="ws-1" />)
    expect(await screen.findByText('1 rule can block a deploy.')).toBeInTheDocument()
  })

  it('shows “off” instead of the severity for a disabled policy', async () => {
    apiFetch.mockImplementation((path) => {
      if (path.endsWith('/policies')) return Promise.resolve({ policies: [{ ...POLICY, enabled: false }] })
      if (path === '/api/policy-templates') return Promise.resolve({ templates: [] })
      return Promise.resolve({})
    })
    render(<PoliciesPage workspaceId="ws-1" />)
    expect(await screen.findByText('off')).toBeInTheDocument()
    expect(screen.getByText('Nothing is currently blocking a deploy.')).toBeInTheDocument()
  })

  it('offers the starter library and copies a template into the editor', async () => {
    render(<PoliciesPage workspaceId="ws-1" />)
    await screen.findByText('Approved hosts')
    fireEvent.click(screen.getByRole('button', { name: /Start from a template/ }))
    expect(await screen.findByText('Outbound calls must use HTTPS')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    // The template's rule lands in an editable field — copied in, not referenced.
    const rule = await screen.findByDisplayValue(TEMPLATES[0].rule)
    expect(rule).toBeInTheDocument()
  })

  it('tests a draft rule against a real workflow before it can be saved', async () => {
    render(<PoliciesPage workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    expect(await screen.findByText(/Does not hold/)).toBeInTheDocument()
    expect(screen.getByText(/evil\.net/)).toBeInTheDocument()
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workspaces/ws-1/policies/evaluate',
        expect.objectContaining({ method: 'POST' })
      )
    )
  })

  it('reports a broken rule inline rather than as a failed request', async () => {
    routeFetch({ evaluate: { ok: false, error: 'rule has a syntax error — Unexpected end' } })
    render(<PoliciesPage workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))
    expect(await screen.findByText(/syntax error/)).toBeInTheDocument()
  })

  it('toggles a policy off without deleting it', async () => {
    render(<PoliciesPage workspaceId="ws-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }))
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/workspaces/ws-1/policies/p1',
        { method: 'PUT', body: { enabled: false } }
      )
    )
    expect(await screen.findByRole('button', { name: 'Enable' })).toBeInTheDocument()
  })

  it('points at the templates when the workspace has no policies', async () => {
    apiFetch.mockImplementation((path) => {
      if (path.endsWith('/policies')) return Promise.resolve({ policies: [] })
      if (path === '/api/policy-templates') return Promise.resolve({ templates: TEMPLATES })
      return Promise.resolve({})
    })
    render(<PoliciesPage workspaceId="ws-1" />)
    expect(await screen.findByText('No policies yet.')).toBeInTheDocument()
    expect(screen.getByText(/Credentials must come from secrets/)).toBeInTheDocument()
  })

  it('surfaces a load failure instead of rendering an empty page silently', async () => {
    apiFetch.mockRejectedValue(new Error('Only workspace owners can manage policies'))
    render(<PoliciesPage workspaceId="ws-1" />)
    expect(await screen.findByText(/Only workspace owners/)).toBeInTheDocument()
  })
})
