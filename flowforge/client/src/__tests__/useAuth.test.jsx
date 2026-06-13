import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { AuthProvider, useAuth } from '../hooks/useAuth'
import { apiFetch } from '../services/api'

// useAuth talks to the backend only through apiFetch — mock it so the hook is
// tested in isolation, with no real network.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

const wrapper = ({ children }) => <AuthProvider>{children}</AuthProvider>
const renderAuth = () => renderHook(() => useAuth(), { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('useAuth initialisation', () => {
  it('starts logged out when storage is empty', () => {
    const { result } = renderAuth()
    expect(result.current.user).toBeNull()
  })

  it('hydrates the user from localStorage', () => {
    localStorage.setItem('user', JSON.stringify({ id: '1', email: 'stored@example.com' }))
    const { result } = renderAuth()
    expect(result.current.user.email).toBe('stored@example.com')
  })
})

describe('login', () => {
  it('persists token + user and updates state', async () => {
    const user = { id: '1', email: 'ada@example.com', displayName: 'Ada' }
    apiFetch.mockResolvedValue({ token: 'tok-123', user })

    const { result } = renderAuth()
    await act(async () => {
      await result.current.login('ada@example.com', 'password123')
    })

    expect(apiFetch).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      body: { email: 'ada@example.com', password: 'password123' },
    })
    expect(result.current.user).toEqual(user)
    expect(localStorage.getItem('token')).toBe('tok-123')
    expect(JSON.parse(localStorage.getItem('user'))).toEqual(user)
  })

  it('stays logged out when the request fails', async () => {
    apiFetch.mockRejectedValue(new Error('Invalid credentials'))

    const { result } = renderAuth()
    await act(async () => {
      await expect(result.current.login('x@example.com', 'nope')).rejects.toThrow('Invalid credentials')
    })

    expect(result.current.user).toBeNull()
    expect(localStorage.getItem('token')).toBeNull()
  })
})

describe('register', () => {
  it('persists token + user and updates state', async () => {
    const user = { id: '2', email: 'new@example.com', displayName: 'New' }
    apiFetch.mockResolvedValue({ token: 'tok-456', user })

    const { result } = renderAuth()
    await act(async () => {
      await result.current.register('new@example.com', 'password123', 'New')
    })

    expect(apiFetch).toHaveBeenCalledWith('/api/auth/register', {
      method: 'POST',
      body: { email: 'new@example.com', password: 'password123', displayName: 'New' },
    })
    expect(result.current.user).toEqual(user)
    expect(localStorage.getItem('token')).toBe('tok-456')
  })
})

describe('logout', () => {
  it('clears state and storage', async () => {
    apiFetch.mockResolvedValue({ token: 'tok', user: { id: '1', email: 'a@b.com' } })
    const { result } = renderAuth()

    await act(async () => {
      await result.current.login('a@b.com', 'pw')
    })
    expect(result.current.user).not.toBeNull()

    act(() => {
      result.current.logout()
    })

    expect(result.current.user).toBeNull()
    expect(localStorage.getItem('token')).toBeNull()
    expect(localStorage.getItem('user')).toBeNull()
  })
})
