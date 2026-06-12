import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'
import { AuthProvider } from '../hooks/useAuth'

// Prevent real socket.io connections during tests
vi.mock('../services/socket', () => ({
  default: {
    auth: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

describe('App', () => {
  it('renders without crashing', () => {
    render(<AuthProvider><App /></AuthProvider>)
  })

  it('shows login page by default when unauthenticated', () => {
    render(<AuthProvider><App /></AuthProvider>)
    expect(screen.getAllByText(/sign in/i).length).toBeGreaterThan(0)
  })
})
