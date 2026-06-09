import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'

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
    render(<App />)
  })

  it('shows login page by default when unauthenticated', () => {
    render(<App />)
    expect(screen.getByText(/sign in/i)).toBeDefined()
  })
})
