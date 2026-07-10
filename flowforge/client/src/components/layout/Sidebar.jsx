import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams, useLocation } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import Skeleton, { SkeletonRows } from '../Skeleton'
import TemplateGallery from '../templates/TemplateGallery'
import ImportWorkflowModal from '../workflows/ImportWorkflowModal'

// Turn a workflow name into a safe download filename: "My Flow!" -> "my-flow.json".
function exportFilename(name) {
  const slug = (name || 'workflow')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'workflow'}.json`
}

export default function Sidebar({ open = false, onNavigate }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { id: currentWorkflowId, wsId: routeWorkspaceId } = useParams()
  const onAnalytics = location.pathname.endsWith('/analytics')
  const onActivity = location.pathname.endsWith('/activity')
  const onSecrets = location.pathname.endsWith('/secrets')
  const onWebhooks = location.pathname.endsWith('/webhooks')

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
  const [showTemplates, setShowTemplates] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState(null)

  // Close the open workflow actions menu on any outside click or Escape. The
  // toggle button stops propagation, so opening/switching menus isn't caught here.
  useEffect(() => {
    if (!menuOpenId) return
    function close() { setMenuOpenId(null) }
    function onKey(e) { if (e.key === 'Escape') setMenuOpenId(null) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpenId])

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
        } else if (routeWorkspaceId) {
          setActiveWorkspaceId(routeWorkspaceId)
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
  }, [currentWorkflowId, routeWorkspaceId])

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

  function handleSelectWorkspace(id) {
    setActiveWorkspaceId(id)
    // Keep the analytics/activity/secrets view in sync when switching workspaces.
    if (onAnalytics) navigate(`/workspace/${id}/analytics`)
    else if (onActivity) navigate(`/workspace/${id}/activity`)
    else if (onSecrets) navigate(`/workspace/${id}/secrets`)
    else if (onWebhooks) navigate(`/workspace/${id}/webhooks`)
  }

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

  // Fetch the workflow's portable export JSON and save it as a file download. The
  // export endpoint returns JSON (not a file); the browser download happens here.
  async function handleExport(workflow) {
    setError(null)
    try {
      const data = await apiFetch(`/api/workflows/${workflow.id}/export`)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFilename(workflow.name)
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
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
              onChange={(e) => handleSelectWorkspace(e.target.value)}
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
        {activeWorkspaceId && (
          <button
            className={`sidebar__nav-link${onAnalytics ? ' sidebar__nav-link--active' : ''}`}
            onClick={() => { navigate(`/workspace/${activeWorkspaceId}/analytics`); onNavigate?.() }}
          >
            <span aria-hidden="true">📊</span> Analytics
          </button>
        )}
        {activeWorkspaceId && (
          <button
            className={`sidebar__nav-link${onActivity ? ' sidebar__nav-link--active' : ''}`}
            onClick={() => { navigate(`/workspace/${activeWorkspaceId}/activity`); onNavigate?.() }}
          >
            <span aria-hidden="true">📜</span> Activity
          </button>
        )}
        {activeWorkspaceId && (
          <button
            className={`sidebar__nav-link${onSecrets ? ' sidebar__nav-link--active' : ''}`}
            onClick={() => { navigate(`/workspace/${activeWorkspaceId}/secrets`); onNavigate?.() }}
          >
            <span aria-hidden="true">🔑</span> Secrets
          </button>
        )}
        {activeWorkspaceId && (
          <button
            className={`sidebar__nav-link${onWebhooks ? ' sidebar__nav-link--active' : ''}`}
            onClick={() => { navigate(`/workspace/${activeWorkspaceId}/webhooks`); onNavigate?.() }}
          >
            <span aria-hidden="true">📡</span> Webhooks
          </button>
        )}
      </div>

      <div className="sidebar__section">
        <div className="sidebar__section-header">
          <span className="sidebar__section-title">Workflows</span>
          <div className="sidebar__header-actions">
            <button
              className="sidebar__icon-btn"
              title="Import workflow"
              aria-label="Import workflow"
              onClick={() => setShowImport(true)}
              disabled={!activeWorkspaceId}
            >
              ↥
            </button>
            <button
              className="sidebar__icon-btn"
              title="New from template"
              onClick={() => setShowTemplates(true)}
              disabled={!activeWorkspaceId}
            >
              ⧉
            </button>
            <button
              className="sidebar__icon-btn"
              title="New workflow"
              onClick={handleCreateWorkflow}
              disabled={!activeWorkspaceId}
            >
              +
            </button>
          </div>
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
                className={`sidebar__workflow${wf.id === currentWorkflowId ? ' sidebar__workflow--active' : ''}${menuOpenId === wf.id ? ' sidebar__workflow--menu-open' : ''}`}
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
                    <div className="sidebar__menu">
                      <button
                        className="sidebar__icon-btn"
                        aria-label="Workflow actions"
                        aria-haspopup="menu"
                        aria-expanded={menuOpenId === wf.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenId((id) => (id === wf.id ? null : wf.id))
                        }}
                      >
                        ⋯
                      </button>
                      {menuOpenId === wf.id && (
                        <div className="sidebar__menu-dropdown" role="menu">
                          <button
                            role="menuitem"
                            className="sidebar__menu-item"
                            onClick={() => { setMenuOpenId(null); startRename(wf) }}
                          >
                            Rename
                          </button>
                          <button
                            role="menuitem"
                            className="sidebar__menu-item"
                            onClick={() => { setMenuOpenId(null); handleExport(wf) }}
                          >
                            Export
                          </button>
                          <button
                            role="menuitem"
                            className="sidebar__menu-item sidebar__menu-item--danger"
                            onClick={() => { setMenuOpenId(null); handleDeleteWorkflow(wf) }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {showTemplates && (
        <TemplateGallery
          workspaceId={activeWorkspaceId}
          onClose={() => setShowTemplates(false)}
          onCreated={(wf) => setWorkflows((prev) => [wf, ...prev])}
        />
      )}

      {showImport && (
        <ImportWorkflowModal
          workspaceId={activeWorkspaceId}
          onClose={() => setShowImport(false)}
          onCreated={(wf) => setWorkflows((prev) => [wf, ...prev])}
        />
      )}
    </aside>
  )
}
