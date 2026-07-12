import { useEffect, useState } from 'react'
import cronstrue from 'cronstrue'
import { apiFetch } from '../../services/api'
import VariableExplorer from './VariableExplorer'
import NodeTester from './NodeTester'

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'expression', label: 'matches expression…' },
]

// One-click cron presets for the schedule trigger (label + standard 5-field cron).
const SCHEDULE_PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 9am', cron: '0 9 * * *' },
  { label: 'Every Monday', cron: '0 9 * * 1' },
  { label: 'Every 1st of month', cron: '0 9 1 * *' },
]

// Turn a cron expression into a human-readable description, or flag it invalid.
function describeCron(expr) {
  try {
    return { text: cronstrue.toString(expr, { throwExceptionOnParseError: true }), error: false }
  } catch {
    return { text: 'Not a valid cron expression yet — e.g. 0 9 * * 1', error: true }
  }
}

// Node count of a workflow from its stored graph_json, for the dropdown preview.
function countNodes(graphJson) {
  try {
    const g = JSON.parse(graphJson)
    return Array.isArray(g.nodes) ? g.nodes.length : 0
  } catch {
    return 0
  }
}

// Searchable picker for the sub-workflow node's target. Lists the workspace's
// deployed workflows (a workflow must be deployed to be callable), excluding the
// current one to avoid the obvious self-reference, and previews each one's node
// count. Selecting a workflow stores its id (what the runner uses) and name (for
// the canvas label) on the node config.
function SubWorkflowConfig({ workspaceId, currentWorkflowId, config, onPick }) {
  const [workflows, setWorkflows] = useState(null) // null = loading
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!workspaceId) {
      setWorkflows([])
      return
    }
    let cancelled = false
    setWorkflows(null)
    setError(null)
    apiFetch(`/api/workspaces/${workspaceId}/workflows`)
      .then(({ workflows: list }) => {
        if (cancelled) return
        const deployed = (list || [])
          .filter((w) => w.status === 'deployed' && w.id !== currentWorkflowId)
          .map((w) => ({ id: w.id, name: w.name, nodeCount: countNodes(w.graph_json) }))
        setWorkflows(deployed)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, currentWorkflowId])

  const selected = workflows?.find((w) => w.id === config.workflowId)
  const q = query.trim().toLowerCase()
  const filtered = (workflows || []).filter((w) => w.name.toLowerCase().includes(q))

  return (
    <div className="subworkflow-config">
      <span className="config-panel__field-label">Workflow to run</span>

      {selected ? (
        <div className="subworkflow-config__selected">
          <span className="subworkflow-config__selected-name">{selected.name}</span>
          <span className="subworkflow-config__count">{selected.nodeCount} nodes</span>
        </div>
      ) : config.workflowId ? (
        <p className="subworkflow-config__missing">
          The selected workflow is no longer available (deleted or undeployed). Pick another.
        </p>
      ) : (
        <p className="config-panel__hint">No workflow selected yet — pick one below.</p>
      )}

      {error && <p className="exec-panel__error">{error}</p>}

      {workflows === null && !error && (
        <p className="config-panel__hint">Loading workflows…</p>
      )}

      {workflows !== null && workflows.length === 0 && !error && (
        <p className="config-panel__hint">
          No other deployed workflows in this workspace. Deploy a workflow to call it here.
        </p>
      )}

      {workflows !== null && workflows.length > 0 && (
        <>
          <input
            className="subworkflow-config__search"
            type="search"
            value={query}
            placeholder="Search workflows…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <ul className="subworkflow-config__list">
            {filtered.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  className={`subworkflow-config__option${
                    w.id === config.workflowId ? ' subworkflow-config__option--selected' : ''
                  }`}
                  onClick={() => onPick(w)}
                >
                  <span className="subworkflow-config__option-name">{w.name}</span>
                  <span className="subworkflow-config__count">{w.nodeCount} nodes</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="config-panel__hint">No workflows match “{query}”.</li>
            )}
          </ul>
        </>
      )}

      <p className="config-panel__hint">
        The parent passes this node’s input as the sub-workflow’s trigger data and
        waits for it to finish; its output is available as{' '}
        <code>{'{{' + 'node-id.field}}'}</code>.
      </p>
    </div>
  )
}

// Shared help for FXL-powered fields (condition expression, filter predicate).
// FXL reads live values from the node's data rather than substituting {{...}}
// templates — a distinction worth calling out where the two styles meet.
function ExpressionHint({ kind }) {
  const scope =
    kind === 'filter' || kind === 'map'
      ? "each item's fields (plus item, index, items)"
      : "the incoming data's fields (plus input)"
  return (
    <p className="config-panel__hint">
      Write a rule over {scope}. Supports <code>&&</code> <code>||</code>{' '}
      <code>==</code> <code>in</code> comparisons, arithmetic, and helpers like{' '}
      <code>len()</code>, <code>upper()</code>, <code>contains()</code>. Unlike a{' '}
      <code>{'{{…}}'}</code> template it reads values directly, so use bare names
      (<code>amount</code>, not <code>{'{{node.amount}}'}</code>). Check ▸ Issues
      flags a bad expression before you run.
    </p>
  )
}

export default function NodeConfigPanel({
  node,
  onChange,
  onClose,
  onDelete,
  workspaceId,
  currentWorkflowId,
  nodes,
  edges,
}) {
  if (!node) return null

  const config = node.data.config || {}

  function setConfig(key, value) {
    onChange(node.id, { config: { ...config, [key]: value } })
  }

  function renderFields() {
    switch (node.type) {
      case 'trigger-manual':
        return (
          <p className="config-panel__hint">
            Manual triggers start the workflow when you press Run.
          </p>
        )
      case 'trigger-webhook':
        return (
          <p className="config-panel__hint">
            Webhook triggers start the workflow when an external service POSTs to
            its URL. Create and copy the URL from the “Webhooks” panel. The request
            body is available downstream as <code>{'{{' + node.id + '.field}}'}</code>.
          </p>
        )
      case 'trigger-schedule': {
        const cronValue = config.cron || ''
        const desc = describeCron(cronValue)
        return (
          <>
            <label className="config-panel__field">
              <span>Cron expression</span>
              <input
                value={cronValue}
                placeholder="0 9 * * 1"
                onChange={(e) => setConfig('cron', e.target.value)}
              />
            </label>
            <p className={`schedule-preview${desc.error ? ' schedule-preview--error' : ''}`}>
              {desc.error ? '⚠ ' : '🕑 '}
              {desc.text}
            </p>
            <div className="schedule-quickpicks">
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  className="schedule-quickpick"
                  onClick={() => setConfig('cron', p.cron)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="config-panel__hint">
              Deploy the workflow to activate the schedule. Runs use the server’s timezone.
            </p>
          </>
        )
      }
      case 'action-http':
        return (
          <>
            <label className="config-panel__field">
              <span>Method</span>
              <select
                value={config.method || 'GET'}
                onChange={(e) => setConfig('method', e.target.value)}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="config-panel__field">
              <span>URL</span>
              <input
                value={config.url || ''}
                placeholder="https://api.example.com/items"
                onChange={(e) => setConfig('url', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Headers (JSON)</span>
              <textarea
                rows={3}
                value={config.headers || '{}'}
                onChange={(e) => setConfig('headers', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Body (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={4}
                value={config.body || ''}
                onChange={(e) => setConfig('body', e.target.value)}
              />
            </label>
            <p className="config-panel__hint">
              Need an API key? Store it once in the workspace’s Secrets page and
              reference it here as <code>{'{{secrets.NAME}}'}</code> — it stays out
              of the graph and is masked in run logs.
            </p>
          </>
        )
      case 'action-delay':
        return (
          <label className="config-panel__field">
            <span>Delay (milliseconds)</span>
            <input
              type="number"
              min={0}
              value={config.durationMs ?? 1000}
              onChange={(e) => setConfig('durationMs', Number(e.target.value))}
            />
          </label>
        )
      case 'action-email':
        return (
          <>
            <label className="config-panel__field">
              <span>To</span>
              <input
                value={config.to || ''}
                placeholder="person@example.com"
                onChange={(e) => setConfig('to', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Subject</span>
              <input
                value={config.subject || ''}
                placeholder="Workflow result"
                onChange={(e) => setConfig('subject', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Body (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={4}
                value={config.body || ''}
                onChange={(e) => setConfig('body', e.target.value)}
              />
            </label>
            <p className="config-panel__hint">
              Without SMTP env configured, sends are simulated (logged, not delivered).
            </p>
          </>
        )
      case 'action-slack':
        return (
          <>
            <label className="config-panel__field">
              <span>Slack webhook URL</span>
              <input
                value={config.webhookUrl || ''}
                placeholder="https://hooks.slack.com/services/..."
                onChange={(e) => setConfig('webhookUrl', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Message (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={4}
                value={config.text || ''}
                placeholder="Run finished: {{node-id.status}}"
                onChange={(e) => setConfig('text', e.target.value)}
              />
            </label>
          </>
        )
      case 'transform':
        return (
          <label className="config-panel__field">
            <span>Output template (JSON, supports {'{{node-id.field}}'})</span>
            <textarea
              rows={6}
              value={config.template || ''}
              onChange={(e) => setConfig('template', e.target.value)}
            />
          </label>
        )
      case 'condition': {
        const isExpression = config.operator === 'expression'
        return (
          <>
            <label className="config-panel__field">
              <span>Operator</span>
              <select
                value={config.operator || 'equals'}
                onChange={(e) => setConfig('operator', e.target.value)}
              >
                {OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
            </label>
            {isExpression ? (
              <>
                <label className="config-panel__field">
                  <span>Expression (true / false)</span>
                  <textarea
                    className="config-panel__code"
                    rows={3}
                    value={config.expression || ''}
                    placeholder={'amount > 1000 && status in ["pending", "review"]'}
                    onChange={(e) => setConfig('expression', e.target.value)}
                  />
                </label>
                <ExpressionHint kind="condition" />
              </>
            ) : (
              <>
                <label className="config-panel__field">
                  <span>Left value (supports {'{{node-id.field}}'})</span>
                  <input
                    value={config.left || ''}
                    placeholder="{{node-id.status}}"
                    onChange={(e) => setConfig('left', e.target.value)}
                  />
                </label>
                <label className="config-panel__field">
                  <span>Right value</span>
                  <input
                    value={config.right || ''}
                    onChange={(e) => setConfig('right', e.target.value)}
                  />
                </label>
              </>
            )}
          </>
        )
      }
      case 'filter':
        return (
          <>
            <label className="config-panel__field">
              <span>Source list (array — supports {'{{node-id.field}}'})</span>
              <textarea
                rows={2}
                value={config.source || ''}
                placeholder={'{{http-1.body}}  or  [1, 2, 3]'}
                onChange={(e) => setConfig('source', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Keep items where (expression)</span>
              <textarea
                className="config-panel__code"
                rows={3}
                value={config.predicate || ''}
                placeholder={'price > 10 && inStock'}
                onChange={(e) => setConfig('predicate', e.target.value)}
              />
            </label>
            <ExpressionHint kind="filter" />
          </>
        )
      case 'map':
        return (
          <>
            <label className="config-panel__field">
              <span>Source list (array — supports {'{{node-id.field}}'})</span>
              <textarea
                rows={2}
                value={config.source || ''}
                placeholder={'{{http-1.body}}  or  [1, 2, 3]'}
                onChange={(e) => setConfig('source', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Map each item to (expression)</span>
              <textarea
                className="config-panel__code"
                rows={3}
                value={config.mapping || ''}
                placeholder={'{ id: item.id, name: upper(name) }'}
                onChange={(e) => setConfig('mapping', e.target.value)}
              />
            </label>
            <ExpressionHint kind="map" />
          </>
        )
      case 'approval':
        return (
          <>
            <label className="config-panel__field">
              <span>Message for approvers (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={3}
                value={config.message || ''}
                placeholder="Deploy {{node-id.version}} to production?"
                onChange={(e) => setConfig('message', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Timeout (minutes)</span>
              <input
                type="number"
                min={1}
                value={config.timeoutMinutes ?? 60}
                onChange={(e) => setConfig('timeoutMinutes', Number(e.target.value))}
              />
            </label>
            <label className="config-panel__field">
              <span>When the timeout expires</span>
              <select
                value={config.onTimeout || 'reject'}
                onChange={(e) => setConfig('onTimeout', e.target.value)}
              >
                <option value="reject">Take the rejected branch</option>
                <option value="fail">Fail the run</option>
              </select>
            </label>
            <p className="config-panel__hint">
              The run pauses here until a workspace member approves or rejects —
              everyone is notified, and the decision can be made from the run
              panel or a notification link. Test runs auto-approve.
            </p>
          </>
        )
      case 'ai-prompt':
        return (
          <>
            <label className="config-panel__field">
              <span>Prompt (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={6}
                value={config.prompt || ''}
                placeholder="Summarize this: {{node-id.body}}"
                onChange={(e) => setConfig('prompt', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>System instructions (optional)</span>
              <textarea
                rows={2}
                value={config.system || ''}
                placeholder="You are a concise assistant."
                onChange={(e) => setConfig('system', e.target.value)}
              />
            </label>
            <p className="config-panel__hint">Returns text as {'{{' + node.id + '.text}}'}.</p>
          </>
        )
      case 'ai-classify':
        return (
          <>
            <label className="config-panel__field">
              <span>Text (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={4}
                value={config.text || ''}
                placeholder="{{node-id.body}}"
                onChange={(e) => setConfig('text', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Labels (comma-separated)</span>
              <input
                value={config.labels || ''}
                placeholder="positive, negative, neutral"
                onChange={(e) => setConfig('labels', e.target.value)}
              />
            </label>
            <p className="config-panel__hint">Returns the chosen label as {'{{' + node.id + '.label}}'}.</p>
          </>
        )
      case 'ai-extract':
        return (
          <>
            <label className="config-panel__field">
              <span>Text (supports {'{{node-id.field}}'})</span>
              <textarea
                rows={4}
                value={config.text || ''}
                placeholder="{{node-id.body}}"
                onChange={(e) => setConfig('text', e.target.value)}
              />
            </label>
            <label className="config-panel__field">
              <span>Fields to extract (comma-separated)</span>
              <input
                value={config.fields || ''}
                placeholder="name, email, company"
                onChange={(e) => setConfig('fields', e.target.value)}
              />
            </label>
            <p className="config-panel__hint">Returns an object as {'{{' + node.id + '.data}}'}.</p>
          </>
        )
      case 'output-log':
        return (
          <label className="config-panel__field">
            <span>Message (supports {'{{node-id.field}}'})</span>
            <textarea
              rows={3}
              value={config.message || ''}
              placeholder="Result: {{node-id.value}}"
              onChange={(e) => setConfig('message', e.target.value)}
            />
          </label>
        )
      case 'sub-workflow':
        return (
          <SubWorkflowConfig
            workspaceId={workspaceId}
            currentWorkflowId={currentWorkflowId}
            config={config}
            onPick={(wf) =>
              onChange(node.id, {
                config: { ...config, workflowId: wf.id, workflowName: wf.name },
              })
            }
          />
        )
      case 'for-each':
        return (
          <>
            <label className="config-panel__field">
              <span>Items (array — supports {'{{node-id.field}}'})</span>
              <textarea
                rows={3}
                value={config.items || ''}
                placeholder={'{{node-id.users}}  or  ["a", "b", "c"]'}
                onChange={(e) => setConfig('items', e.target.value)}
              />
            </label>
            <SubWorkflowConfig
              workspaceId={workspaceId}
              currentWorkflowId={currentWorkflowId}
              config={config}
              onPick={(wf) =>
                onChange(node.id, {
                  config: { ...config, workflowId: wf.id, workflowName: wf.name },
                })
              }
            />
            <label className="config-panel__checkbox">
              <input
                type="checkbox"
                checked={Boolean(config.continueOnError)}
                onChange={(e) => setConfig('continueOnError', e.target.checked)}
              />
              <span>Continue on error — record failed items and keep going</span>
            </label>
            <p className="config-panel__hint">
              Runs the workflow once per item (sequentially, max 100). Each run
              receives <code>{'{{trigger-id.item}}'}</code>,{' '}
              <code>{'{{trigger-id.index}}'}</code>, and{' '}
              <code>{'{{trigger-id.total}}'}</code>; results aggregate as{' '}
              <code>{'{{' + node.id + '.results}}'}</code>.
            </p>
          </>
        )
      case 'output-return':
        return (
          <p className="config-panel__hint">
            Marks what this workflow returns. Its incoming data becomes the workflow’s
            final output — and, when this workflow is called by a sub-workflow node,
            that node’s output.
          </p>
        )
      default:
        return <p className="config-panel__hint">No configuration for this node type.</p>
    }
  }

  return (
    <aside className="config-panel">
      <div className="config-panel__header">
        <span className="config-panel__title">{node.data.label || node.type}</span>
        <button className="config-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="config-panel__body">
        <label className="config-panel__field">
          <span>Label</span>
          <input
            value={node.data.label || ''}
            onChange={(e) => onChange(node.id, { label: e.target.value })}
          />
        </label>
        {renderFields()}
        <VariableExplorer node={node} nodes={nodes} edges={edges} />
        <NodeTester workflowId={currentWorkflowId} node={node} />
        <div className="config-panel__node-id">
          Node ID: <code>{node.id}</code>
        </div>
      </div>
      <div className="config-panel__footer">
        <button
          className="config-panel__delete"
          onClick={() => onDelete(node.id)}
        >
          Delete node
        </button>
      </div>
    </aside>
  )
}
