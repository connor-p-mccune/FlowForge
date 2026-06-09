import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../services/api'
import Header from '../layout/Header'

export default function DashboardPage() {
  const navigate = useNavigate()
  const [workspaces, setWorkspaces] = useState([])
  const [workflows, setWorkflows] = useState([])
  const [activeWorkspace, setActiveWorkspace] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    apiFetch('/api/workspaces')
      .then(({ workspaces: ws }) => {
        setWorkspaces(ws)
        if (ws.length > 0) setActiveWorkspace(ws[0])
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!activeWorkspace) return
    apiFetch(`/api/workspaces/${activeWorkspace.id}/workflows`)
      .then(({ workflows: wf }) => setWorkflows(wf))
      .catch((err) => setError(err.message))
  }, [activeWorkspace])

  async function handleNewWorkflow() {
    if (!activeWorkspace) return
    setCreating(true)
    setError(null)
    try {
      const { workflow } = await apiFetch(`/api/workspaces/${activeWorkspace.id}/workflows`, {
        method: 'POST',
        body: { name: 'Untitled workflow' },
      })
      navigate(`/workflow/${workflow.id}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="app-layout">
      <Header />
      <div className="dashboard">
        {loading && <p className="dashboard__loading">Loading…</p>}
        {error && <p className="dashboard__error">{error}</p>}
        {!loading && activeWorkspace && (
          <>
            <div className="dashboard__header">
              <h2 className="dashboard__title">{activeWorkspace.name}</h2>
              <button
                className="dashboard__new-btn"
                onClick={handleNewWorkflow}
                disabled={creating}
              >
                {creating ? 'Creating…' : '+ New workflow'}
              </button>
            </div>
            <ul className="workflow-list">
              {workflows.length === 0 && (
                <li className="workflow-list__empty">
                  No workflows yet. Create your first one.
                </li>
              )}
              {workflows.map((wf) => (
                <li key={wf.id} className="workflow-list__item">
                  <button
                    className="workflow-list__link"
                    onClick={() => navigate(`/workflow/${wf.id}`)}
                  >
                    <span className="workflow-list__name">{wf.name}</span>
                    <span className="workflow-list__date">
                      {new Date(wf.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
