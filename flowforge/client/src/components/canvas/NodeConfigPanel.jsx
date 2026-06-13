const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
]

export default function NodeConfigPanel({ node, onChange, onClose, onDelete }) {
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
      case 'condition':
        return (
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
            <label className="config-panel__field">
              <span>Right value</span>
              <input
                value={config.right || ''}
                onChange={(e) => setConfig('right', e.target.value)}
              />
            </label>
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
