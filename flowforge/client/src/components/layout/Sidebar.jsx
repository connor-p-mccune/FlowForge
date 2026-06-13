import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import Skeleton, { SkeletonRows } from '../Skeleton'

export default function Sidebar({ open = false, onNavigate }) {
  const navigate = useNavigate()
  const { id: currentWorkflowId } = useParams()

  const [workspaces, setWorkspaces] = useState([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null)
  const [workflows, setWorkflows] = useState([])
  const [error, setError] = useState(null)
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(true)
  const [loadingWorkflows, setLoadingWorkflows] = useState(true)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')

  // Initial load: workspaces, and if a workflow is open, select its workspace
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { workspaces: ws } = await apiFetch('/api/workspaces')
        if (cancelled) return
        setWorkspaces(ws)
        if (currentWorkflowId) {
          const { workflow } = await apiFetch(`/api/workflows/${currentWorkflowId}`)
          if (cancelled) return
          setActiveWorkspaceId(workflow.workspace_id)
        } else if (ws.length > 0) {
          setActiveWorkspaceId((prev) => prev || ws[0].id)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoadingWorkspaces(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [currentWorkflowId])

  const loadWorkflows = useCallback(async () => {
    if (!activeWorkspaceId) {
      setWorkflows([])
      setLoadingWorkflows(false)
      return
    }
    setLoadingWorkflows(true)
    try {
      const { workflows: wf } = await apiFetch(`/api/workspaces/${activeWorkspaceId}/workflows`)
      setWorkflows(wf)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingWorkflows(false)
    }
  }, [activeWorkspaceId])

  useEffect(() => { loadWorkflows() }, [loadWorkflows])

  async function handleCreateWorkspace(e) {
    e.preventDefault()
    const name = newWorkspaceName.trim()
    if (!name) return
    setError(null)
    try {
      const { workspace } = await apiFetch('/api/workspaces', {
        method: 'POST',
        body: { name },
      })
      setWorkspaces((ws) => [workspace, ...ws])
      setActiveWorkspaceId(workspace.id)
      setNewWorkspaceName('')
      setCreatingWorkspace(false)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeleteWorkspace() {
    const ws = workspaces.find((w) => w.id === activeWorkspaceId)
    if (!ws) return
    if (!window.confirm(`Delete workspace "${ws.name}" and all its workflows?`)) return
    setError(null)
    try {
      await apiFetch(`/api/workspaces/${ws.id}`, { method: 'DELETE' })
      const remaining = workspaces.filter((w) => w.id !== ws.id)
      setWorkspaces(remaining)
      setActiveWorkspaceId(remaining[0]?.id || null)
      setWorkflows([])
      navigate('/')
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleCreateWorkflow() {
    if (!activeWorkspaceId) return
    setError(null)
    try {
      const { workflow } = await apiFetch(`/api/workspaces/${activeWorkspaceId}/workflows`, {
        method: 'POST',
        body: { name: 'Untitled workflow' },
      })
      setWorkflows((wf) => [workflow, ...wf])
      navigate(`/workflow/${workflow.id}`)
      onNavigate?.()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeleteWorkflow(workflow) {
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return
    setError(null)
    try {
      await apiFetch(`/api/workflows/${workflow.id}`, { method: 'DELETE' })
      setWorkflows((wf) => wf.filter((w) => w.id !== workflow.id))
      if (workflow.id === currentWorkflowId) navigate('/')
    } catch (err) {
      setError(err.message)
    }
  }

  function startRename(workflow) {
    setRenamingId(workflow.id)
    setRenameValue(workflow.name)
  }

  async function handleRenameWorkflow(e) {
    e.preventDefault()
    const name = renameValue.trim()
    if (!name) return setRenamingId(null)
    setError(null)
    try {
      const { workflow } = await apiFetch(`/api/workflows/${renamingId}`, {
        method: 'PUT',
        body: { name },
      })
      setWorkflows((wf) => wf.map((w) => (w.id === workflow.id ? workflow : w)))
    } catch (err) {
      setError(err.message)
    } finally {
      setRenamingId(null)
    }
  }

  return (
    <aside className={`sidebar${open ? ' sidebar--open' : ''}`}>
      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-title">Workspace</span>
          <button
            className="sidebar__icon-btn"
            title="New workspace"
            onClick={() => setCreatingWorkspace((v) => !v)}
          >
            +
          </button>
        </div>
        {creatingWorkspace && (
          <form className="sidebar__inline-form" onSubmit={handleCreateWorkspace}>
            <input
              className="sidebar__input"
              autoFocus
              placeholder="Workspace name"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
            />
            <button className="sidebar__small-btn" type="submit">Add</button>
          </form>
        )}
        {loadingWorkspaces ? (
          <Skeleton height={32} />
        ) : workspaces.length === 0 ? (
          <p className="sidebar__empty">No workspaces yet. Create one with +.</p>
        ) : (
          <div className="sidebar__workspace-row">
            <select
              className="sidebar__select"
              value={activeWorkspaceId || ''}
              onChange={(e) => setActiveWorkspaceId(e.target.value)}
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
            <button
              className="sidebar__icon-btn sidebar__icon-btn--danger"
              title="Delete workspace"
              onClick={handleDeleteWorkspace}
              disabled={!activeWorkspaceId}
            >
              🗑
            </button>
          </div>
        )}
      </div>

      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-title">Workflows</span>
          <button
            className="sidebar__icon-btn"
            title="New workflow"
            onClick={handleCreateWorkflow}
            disabled={!activeWorkspaceId}
          >
            +
          </button>
        </div>
        {error && <p className="sidebar__error">{error}</p>}
        {loadingWorkflows ? (
          <SkeletonRows count={4} height={30} />
        ) : workflows.length === 0 ? (
          <p className="sidebar__empty">No workflows yet. Click + to create one.</p>
        ) : (
          <ul className="sidebar__workflow-list">
            {workflows.map((wf) => (
              <li
                key={wf.id}
                className={`sidebar__workflow${wf.id === currentWorkflowId ? ' sidebar__workflow--active' : ''}`}
              >
                {renamingId === wf.id ? (
                  <form className="sidebar__inline-form" onSubmit={handleRenameWorkflow}>
                    <input
                      className="sidebar__input"
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleRenameWorkflow}
                    />
                  </form>
                ) : (
                  <>
                    <button
                      className="sidebar__workflow-link"
                      onClick={() => { navigate(`/workflow/${wf.id}`); onNavigate?.() }}
                      onDoubleClick={() => startRename(wf)}
                      title="Double-click to rename"
                    >
                      {wf.name}
                    </button>
                    <button
                      className="sidebar__icon-btn"
                      title="Rename"
                      onClick={() => startRename(wf)}
                    >
                      ✎
                    </button>
                    <button
                      className="sidebar__icon-btn sidebar__icon-btn--danger"
                      title="Delete"
                      onClick={() => handleDeleteWorkflow(wf)}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
