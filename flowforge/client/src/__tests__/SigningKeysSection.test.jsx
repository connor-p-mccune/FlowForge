import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import SigningKeysSection from '../components/secrets/SigningKeysSection'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n'

const KEY = {
  id: 'k1',
  name: 'release key',
  publicKey: PUBLIC_KEY,
  fingerprint: 'ded9fc50:64e8f727:0ccd86dc:9a9762fa:36be2c6a:91016241:d309087e:c72efc23',
  addedBy: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  revokedAt: null,
  active: true,
}

const REVOKED = {
  ...KEY,
  id: 'k0',
  name: 'old key',
  fingerprint: 'aaaaaaaa:bbbbbbbb:cccccccc:dddddddd:eeeeeeee:ffffffff:11111111:22222222',
  revokedAt: '2026-02-02T00:00:00.000Z',
  active: false,
}

// The section fetches its own state and renders nothing when refused, so every
// test declares what the GET returns.
function mockState(state, { onWrite } = {}) {
  apiFetch.mockImplementation((url, options) => {
    if (!options) {
      return state instanceof Error ? Promise.reject(state) : Promise.resolve(state)
    }
    return Promise.resolve(onWrite ? onWrite(url, options) : { key: KEY })
  })
}

beforeEach(() => {
  apiFetch.mockReset()
  toast.success.mockReset()
  toast.error.mockReset()
})

const setup = () => render(<SigningKeysSection workspaceId="ws1" />)

describe('SigningKeysSection', () => {
  it('renders nothing at all for someone who is not an owner', async () => {
    mockState(new Error('Only workspace owners can manage signing keys'))
    const { container } = setup()
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    // Not an error message — a non-owner should not learn the section exists.
    expect(container.querySelector('.signing-keys')).toBeNull()
  })

  it('lists trusted keys with their fingerprint and who added them', async () => {
    mockState({ keys: [KEY], requireSignedImports: false })
    setup()
    expect(await screen.findByText('release key')).toBeInTheDocument()
    expect(screen.getByText(KEY.fingerprint)).toBeInTheDocument()
    expect(screen.getByText(/by Ada/)).toBeInTheDocument()
  })

  it('keeps a revoked key listed, because what it signed still matters', async () => {
    mockState({ keys: [KEY, REVOKED], requireSignedImports: false })
    setup()
    expect(await screen.findByText('old key')).toBeInTheDocument()
    expect(screen.getByText(/revoked/)).toBeInTheDocument()
    // …and offers no Revoke button for it.
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1)
  })

  it('trusts a pasted public key', async () => {
    const posts = []
    mockState({ keys: [], requireSignedImports: false }, {
      onWrite: (url, options) => {
        posts.push({ url, options })
        return { key: KEY, reinstated: false }
      },
    })
    setup()
    fireEvent.click(await screen.findByRole('button', { name: /Trust a key/ }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'release key' } })
    fireEvent.change(screen.getByLabelText(/Public key/), { target: { value: PUBLIC_KEY } })
    fireEvent.click(screen.getByRole('button', { name: /Trust this key/ }))

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/workspaces/ws1/signing-keys')
    expect(posts[0].options.body).toEqual({ name: 'release key', publicKey: PUBLIC_KEY })
    expect(toast.success).toHaveBeenCalledWith('Now trusting release key.')
  })

  it('surfaces a rejected key inline rather than as a toast', async () => {
    mockState({ keys: [], requireSignedImports: false }, {
      onWrite: () => Promise.reject(new Error('publicKey is not a valid PEM public key')),
    })
    setup()
    fireEvent.click(await screen.findByRole('button', { name: /Trust a key/ }))
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText(/Public key/), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: /Trust this key/ }))
    expect(await screen.findByText(/not a valid PEM/)).toBeInTheDocument()
  })

  it('revokes a key and says what that means', async () => {
    const calls = []
    mockState({ keys: [KEY], requireSignedImports: false }, {
      onWrite: (url, options) => {
        calls.push({ url, method: options.method })
        return {}
      },
    })
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ url: '/api/workspaces/ws1/signing-keys/k1', method: 'DELETE' })
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringMatching(/no longer trusted/)
    )
  })

  it('states that enforcement is only about unsigned imports', async () => {
    mockState({ keys: [KEY], requireSignedImports: false })
    setup()
    // The sentence the whole feature rests on: a broken signature is refused
    // either way, and a UI that left that ambiguous would make signing
    // decorative.
    expect(
      await screen.findByText(/refused\s+whether or not this is on/i)
    ).toBeInTheDocument()
  })

  it('will not let enforcement be switched on with nothing trusted', async () => {
    mockState({ keys: [], requireSignedImports: false })
    setup()
    const toggle = await screen.findByRole('checkbox')
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/lock out your own promotions/)).toBeInTheDocument()
  })

  it('turns enforcement on', async () => {
    const calls = []
    mockState({ keys: [KEY], requireSignedImports: false }, {
      onWrite: (url, options) => {
        calls.push({ url, body: options.body })
        return { requireSignedImports: true }
      },
    })
    setup()
    fireEvent.click(await screen.findByRole('checkbox'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      url: '/api/workspaces/ws1/signing-keys/enforcement',
      body: { requireSignedImports: true },
    })
    expect(toast.success).toHaveBeenCalledWith('Unsigned imports are now refused.')
  })

  it('says what an empty trust store means for imports', async () => {
    mockState({ keys: [], requireSignedImports: false })
    setup()
    expect(await screen.findByText(/every import is unsigned and recorded as such/)).toBeInTheDocument()
  })
})
