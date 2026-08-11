import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import MergeModal from '../components/canvas/MergeModal'
import { apiFetch } from '../services/api'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
const toast = { success: vi.fn(), error: vi.fn() }
vi.mock('../hooks/useToast', () => ({ useToast: () => toast }))

const DOC = {
  exportVersion: '1.0',
  name: 'Sync',
  graph_data: {
    nodes: [{ id: 't1', type: 'trigger-manual', position: { x: 0, y: 0 }, data: { label: 't1' } }],
    edges: [],
  },
}

const CLEAN = {
  workflowId: 'wf1',
  clean: true,
  applied: false,
  base: { versionId: 'v1', version: 4 },
  conflicts: [],
  droppedEdges: [],
  summary: { added: 1, removed: 0, changed: 2, unchanged: 3 },
  lint: { errors: 0, warnings: 0, issues: [] },
}

const CONFLICTED = {
  ...CLEAN,
  clean: false,
  conflicts: [
    {
      kind: 'field',
      nodeId: 'h1',
      label: 'Charge card',
      field: 'config.url',
      base: 'https://pay/v1',
      ours: 'https://pay/v2',
      theirs: 'https://pay/legacy',
      description: 'Charge card · config.url',
    },
  ],
  lint: null,
}

// jsdom's FileReader works, but the component reads asynchronously — a real
// File keeps the test honest about that path rather than stubbing it out.
function pickFile(doc = DOC) {
  const input = document.querySelector('input[type="file"]')
  const file = new File([JSON.stringify(doc)], 'sync.json', { type: 'application/json' })
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

const modal = (props = {}) =>
  render(<MergeModal workflowId="wf1" onClose={() => {}} onMerged={() => {}} {...props} />)

describe('MergeModal', () => {
  it('previews as soon as a file is picked, without applying', async () => {
    apiFetch.mockResolvedValue(CLEAN)
    modal()
    pickFile()

    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    expect(apiFetch.mock.calls[0][1].body).toMatchObject({ strategy: 'manual', apply: false })
    expect(await screen.findByText(/Merges cleanly/)).toBeInTheDocument()
    expect(screen.getByText(/version 4/)).toBeInTheDocument()
  })

  it('applies only when asked', async () => {
    apiFetch.mockResolvedValue(CLEAN)
    const onMerged = vi.fn()
    modal({ onMerged })
    pickFile()

    const apply = await screen.findByRole('button', { name: /apply to the canvas/i })
    apiFetch.mockResolvedValue({ ...CLEAN, applied: true })
    fireEvent.click(apply)

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(apiFetch.mock.calls.at(-1)[1].body.apply).toBe(true)
    expect(onMerged).toHaveBeenCalled()
  })

  it('shows the three competing values for a conflict', async () => {
    apiFetch.mockResolvedValue(CONFLICTED)
    modal()
    pickFile()

    expect(await screen.findByText(/1 conflict — nothing was written/)).toBeInTheDocument()
    // The ancestor, the live value, and the file's — the comparison a merge
    // tool exists to present.
    expect(screen.getByText('https://pay/v1')).toBeInTheDocument()
    expect(screen.getByText('https://pay/v2')).toBeInTheDocument()
    expect(screen.getByText('https://pay/legacy')).toBeInTheDocument()
    expect(screen.getByText('config.url')).toBeInTheDocument()
  })

  it('offers per-side resolution only when there are conflicts', async () => {
    apiFetch.mockResolvedValue(CONFLICTED)
    modal()
    pickFile()

    const keepLive = await screen.findByRole('button', { name: /keep live values/i })
    expect(screen.getByRole('button', { name: /take the file/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /apply to the canvas/i })).not.toBeInTheDocument()

    apiFetch.mockResolvedValue({ ...CLEAN, applied: true })
    fireEvent.click(keepLive)
    await waitFor(() =>
      expect(apiFetch.mock.calls.at(-1)[1].body).toMatchObject({ strategy: 'ours', apply: true })
    )
  })

  it('rejects a file that is not a workflow export without calling the server', async () => {
    modal()
    pickFile({ nope: true })
    expect(await screen.findByText(/missing workflow data/)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('warns about connections the merge dropped', async () => {
    apiFetch.mockResolvedValue({
      ...CLEAN,
      droppedEdges: [{ source: 't1', target: 'h1', sourceHandle: null, reason: 'endpoint removed' }],
    })
    modal()
    pickFile()
    expect(await screen.findByText(/1 connection dropped/)).toBeInTheDocument()
  })

  it('says when there is no ancestry to merge against', async () => {
    apiFetch.mockResolvedValue({
      ...CLEAN,
      base: { versionId: null, version: null, note: 'no version snapshots' },
    })
    modal()
    pickFile()
    expect(await screen.findByText(/no deploys yet/)).toBeInTheDocument()
  })
})
