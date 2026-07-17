// {{vars.NAME}} resolution: workspace variables flow into node configs through
// the engine's template scope, exactly like secrets — but as plain config, so
// their values are allowed to appear in persisted step rows.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')
const { encryptSecret } = require('../services/secretVault')

function seedWorkflow(graph) {
  const userId = uuidv4()
  const wsId = uuidv4()
  const wfId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'Test', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(wsId, 'WS', userId, now, now)
  db.prepare(
    'INSERT INTO workflows (id, workspace_id, name, graph_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(wfId, wsId, 'WF', JSON.stringify(graph), userId, now, now)

  const execId = uuidv4()
  db.prepare(
    'INSERT INTO executions (id, workflow_id, status, triggered_by, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(execId, wfId, 'pending', userId, now)
  return { execId, wfId, wsId, userId }
}

function setVariable(wsId, name, value) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO workspace_variables (id, workspace_id, name, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuidv4(), wsId, name, value, now, now)
}

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const stepFor = (execId, nodeId) =>
  db.prepare('SELECT * FROM execution_steps WHERE execution_id = ? AND node_id = ?').get(execId, nodeId)

describe('workspace variable resolution', () => {
  it('resolves {{vars.NAME}} in node configs and persists the value unredacted', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', { message: 'Base URL is {{vars.API_BASE_URL}}' }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId, wsId } = seedWorkflow(graph)
    setVariable(wsId, 'API_BASE_URL', 'https://api.example.com')

    await runExecution(execId, { publish: () => {} })

    expect(db.prepare('SELECT status FROM executions WHERE id = ?').get(execId).status).toBe('completed')
    const output = JSON.parse(stepFor(execId, 'o1').output_json)
    // Variables are config, not credentials — the value is visible in the log.
    expect(output.message).toBe('Base URL is https://api.example.com')
  })

  it('resolves a missing variable like any missing placeholder (empty string)', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', { message: 'x={{vars.NOPE}}' }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)

    await runExecution(execId, { publish: () => {} })
    expect(JSON.parse(stepFor(execId, 'o1').output_json).message).toBe('x=')
  })

  it('keeps variables out of the redactor: a secret with the same value is still masked', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', {
          message: 'var={{vars.SHARED}} secret={{secrets.SHARED_SECRET}}',
        }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId, wsId } = seedWorkflow(graph)
    setVariable(wsId, 'SHARED', 'plain-config-value')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO workspace_secrets (id, workspace_id, name, value_encrypted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), wsId, 'SHARED_SECRET', encryptSecret('super-secret-9000'), now, now)

    await runExecution(execId, { publish: () => {} })
    const output = JSON.parse(stepFor(execId, 'o1').output_json)
    expect(output.message).toContain('plain-config-value')
    expect(output.message).not.toContain('super-secret-9000')
  })

  it('variables are scoped to the workflow\'s workspace', async () => {
    const graph = {
      nodes: [
        node('t1', 'trigger-manual'),
        node('o1', 'output-log', { message: 'v={{vars.ONLY_ELSEWHERE}}' }),
      ],
      edges: [edge('t1', 'o1')],
    }
    const { execId } = seedWorkflow(graph)
    // Same name, different workspace — must not leak across.
    const other = seedWorkflow({ nodes: [], edges: [] })
    setVariable(other.wsId, 'ONLY_ELSEWHERE', 'foreign-value')

    await runExecution(execId, { publish: () => {} })
    expect(JSON.parse(stepFor(execId, 'o1').output_json).message).toBe('v=')
  })
})
