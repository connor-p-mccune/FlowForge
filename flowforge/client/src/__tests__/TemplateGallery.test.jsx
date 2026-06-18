import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import TemplateGallery from '../components/templates/TemplateGallery'
import { apiFetch } from '../services/api'

// All HTTP goes through services/api — mock it so the test controls responses.
vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))

// The gallery navigates to the new workflow after cloning; capture that call.
// vi.hoisted lets the mock factory reference the spy despite vi.mock hoisting.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }))

// Two categories so category-filter and search behaviour are observable. Each
// card's accessible name includes its (unique) description, which the preview
// renders in a non-button <p> — so getByRole('button', { name: /description/ })
// targets a specific card without colliding with the preview panel.
const TEMPLATES = {
  'AI Automation': [
    {
      id: 't-ai',
      name: 'AI Classify Flow',
      description: 'Classify incoming events with AI',
      category: 'AI Automation',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger-webhook', data: { label: 'Incoming Event' } },
          { id: 'classify', type: 'ai-classify', data: { label: 'Classify Message' } },
          { id: 'alert', type: 'action-slack', data: { label: 'Send Slack Alert' } },
        ],
        edges: [
          { id: 'e1', source: 'trigger', target: 'classify', sourceHandle: null },
          { id: 'e2', source: 'classify', target: 'alert', sourceHandle: null },
        ],
      },
    },
  ],
  Reporting: [
    {
      id: 't-report',
      name: 'Daily Report Flow',
      description: 'Fetch metrics and email a report',
      category: 'Reporting',
      graph: {
        nodes: [
          { id: 'trigger', type: 'trigger-manual', data: { label: 'Daily Schedule' } },
          { id: 'email', type: 'action-email', data: { label: 'Email Report' } },
        ],
        edges: [{ id: 'e1', source: 'trigger', target: 'email', sourceHandle: null }],
      },
    },
  ],
}

function mockApi() {
  apiFetch.mockImplementation((path, opts) => {
    if (path === '/api/templates') return Promise.resolve({ templates: TEMPLATES })
    if (path === '/api/workspaces/ws1/workflows/from-template') {
      return Promise.resolve({ workflow: { id: 'wf-new', name: opts.body.name } })
    }
    return Promise.reject(new Error(`unexpected request: ${path}`))
  })
}

function setup(props = {}) {
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() }
  const utils = render(<TemplateGallery workspaceId="ws1" {...handlers} {...props} />)
  return { ...handlers, ...utils }
}

// Find a template card (a button) by a substring of its description.
const card = (re) => screen.getByRole('button', { name: re })
const queryCard = (re) => screen.queryByRole('button', { name: re })

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
})

describe('TemplateGallery', () => {
  it('loads templates and renders a card per template plus category filters', async () => {
    setup()
    expect(await screen.findByRole('button', { name: /Classify incoming events/ })).toBeInTheDocument()
    expect(card(/Fetch metrics and email a report/)).toBeInTheDocument()
    // Filter chips for the fixed category list.
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'AI Automation' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reporting' })).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/api/templates')
  })

  it('filters the list by category', async () => {
    setup()
    await screen.findByRole('button', { name: /Classify incoming events/ })
    fireEvent.click(screen.getByRole('button', { name: 'Reporting' }))
    expect(queryCard(/Classify incoming events/)).not.toBeInTheDocument()
    expect(card(/Fetch metrics and email a report/)).toBeInTheDocument()
  })

  it('shows an empty state for a category with no templates', async () => {
    setup()
    await screen.findByRole('button', { name: /Classify incoming events/ })
    fireEvent.click(screen.getByRole('button', { name: 'Resilience' }))
    expect(screen.getByText(/No templates match your search/)).toBeInTheDocument()
  })

  it('searches across name and description', async () => {
    setup()
    await screen.findByRole('button', { name: /Classify incoming events/ })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'report' } })
    expect(queryCard(/Classify incoming events/)).not.toBeInTheDocument()
    expect(card(/Fetch metrics and email a report/)).toBeInTheDocument()
  })

  it('previews the selected template (auto-selects the first, switches on click)', async () => {
    setup()
    // First template is auto-selected, so its detail heading shows on load.
    expect(
      await screen.findByRole('heading', { level: 3, name: 'AI Classify Flow' })
    ).toBeInTheDocument()
    expect(screen.getByText('Steps')).toBeInTheDocument()
    expect(screen.getByText('Connections')).toBeInTheDocument()

    fireEvent.click(card(/Fetch metrics and email a report/))
    expect(screen.getByRole('heading', { level: 3, name: 'Daily Report Flow' })).toBeInTheDocument()
  })

  it('clones the selected template into the workspace, then notifies and navigates', async () => {
    const { onCreated, onClose } = setup()
    // Default selection is the first template (AI Classify Flow).
    await screen.findByRole('heading', { level: 3, name: 'AI Classify Flow' })

    fireEvent.click(screen.getByRole('button', { name: 'Use Template' }))

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: 'wf-new', name: 'AI Classify Flow' })
    )
    expect(apiFetch).toHaveBeenCalledWith('/api/workspaces/ws1/workflows/from-template', {
      method: 'POST',
      body: { templateId: 't-ai', name: 'AI Classify Flow' },
    })
    expect(navigate).toHaveBeenCalledWith('/workflow/wf-new')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes via the × button', async () => {
    const { onClose } = setup()
    await screen.findByRole('searchbox')
    fireEvent.click(screen.getByRole('button', { name: '×' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const { onClose } = setup()
    await screen.findByRole('searchbox')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
