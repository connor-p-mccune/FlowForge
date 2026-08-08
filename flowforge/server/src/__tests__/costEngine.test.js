// Cost metering inside a real run: the engine records what a step spent, keeps
// the metering out of the data plane, and totals the run — including when it
// fails partway.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

jest.mock('../config/queue', () => ({ getExecutionQueue: () => ({ add: jest.fn() }) }))
jest.mock('../config/redis', () => ({ publish: jest.fn().mockResolvedValue(1) }))

// The AI runners call out through aiClient; stub it so a run can produce real
// usage without a Python service or an API key.
const mockCallAiService = jest.fn()
jest.mock('../services/aiClient', () => ({
  callAiService: (...args) => mockCallAiService(...args),
  aiServiceUrl: () => 'http://ai.test',
}))

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const { runExecution } = require('../services/executionEngine')

const node = (id, type, config = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, config },
})

let workspaceId
let userId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  db.prepare(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES (?, 'cost-engine@example.com', 'x', 'Cost')"
  ).run(userId)
  db.prepare('INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)').run(
    workspaceId,
    'Cost WS',
    userId
  )
})

// Build a workflow + a queued execution, run it, and hand back the rows.
async function runGraph(nodes, edges = [], { dryRun = false } = {}) {
  const workflowId = uuidv4()
  const executionId = uuidv4()
  db.prepare(
    `INSERT INTO workflows (id, workspace_id, name, graph_json, status, created_by)
     VALUES (?, ?, 'Cost WF', ?, 'deployed', ?)`
  ).run(workflowId, workspaceId, JSON.stringify({ nodes, edges }), userId)
  db.prepare(
    "INSERT INTO executions (id, workflow_id, status, trigger_type, created_at) VALUES (?, ?, 'pending', ?, ?)"
  ).run(executionId, workflowId, dryRun ? 'dry-run' : 'manual', new Date().toISOString())

  const result = await runExecution(executionId, { publish: () => {}, dryRun })
  return {
    executionId,
    result,
    execution: db.prepare('SELECT * FROM executions WHERE id = ?').get(executionId),
    steps: db.prepare('SELECT * FROM execution_steps WHERE execution_id = ?').all(executionId),
  }
}

const stepFor = (steps, nodeId) => steps.find((s) => s.node_id === nodeId)

beforeEach(() => mockCallAiService.mockReset())

describe('step cost metering', () => {
  it('prices an AI step and totals it onto the run', async () => {
    mockCallAiService.mockResolvedValue({
      text: 'a summary',
      usage: { model: 'gpt-4o-mini', promptTokens: 2000, completionTokens: 1000 },
    })
    const { execution, steps } = await runGraph([
      node('t', 'trigger-manual'),
      node('ai', 'ai-prompt', { prompt: 'summarise' }),
    ], [{ id: 'e1', source: 't', target: 'ai' }])

    // 2000 in @ $0.15/1M + 1000 out @ $0.60/1M = 300 + 600 = 900 micro-USD.
    expect(stepFor(steps, 'ai').cost_micro_usd).toBe(900)
    expect(JSON.parse(stepFor(steps, 'ai').usage_json)).toMatchObject({
      kind: 'tokens',
      model: 'gpt-4o-mini',
      promptTokens: 2000,
      priced: true,
    })
    expect(execution.cost_micro_usd).toBe(900)
  })

  it('keeps metering out of the node’s output entirely', async () => {
    // Usage is a side channel from runner to engine. If it leaked it would land
    // in the context every downstream node reads, in the persisted step output,
    // and in the run's return value — three places it has no business being.
    mockCallAiService.mockResolvedValue({
      text: 'a summary',
      usage: { model: 'gpt-4o-mini', promptTokens: 10, completionTokens: 10 },
    })
    const { steps, result } = await runGraph([
      node('t', 'trigger-manual'),
      node('ai', 'ai-prompt', { prompt: 'summarise' }),
    ], [{ id: 'e1', source: 't', target: 'ai' }])

    const output = JSON.parse(stepFor(steps, 'ai').output_json)
    expect(output).toEqual({ text: 'a summary' })
    expect(output.usage).toBeUndefined()
    expect(result.usage).toBeUndefined()
  })

  it('sums several metered steps across a run', async () => {
    mockCallAiService.mockResolvedValue({
      text: 'x',
      usage: { model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 0 },
    })
    const { execution } = await runGraph(
      [
        node('t', 'trigger-manual'),
        node('a1', 'ai-prompt', { prompt: 'one' }),
        node('a2', 'ai-prompt', { prompt: 'two' }),
      ],
      [
        { id: 'e1', source: 't', target: 'a1' },
        { id: 'e2', source: 'a1', target: 'a2' },
      ]
    )
    expect(execution.cost_micro_usd).toBe(300) // 150 + 150
  })

  it('records what a failed run spent before it failed', async () => {
    // A budget that only counted successes would be trivially defeated by a
    // workflow that dies after its expensive step.
    mockCallAiService.mockResolvedValue({
      text: 'x',
      usage: { model: 'gpt-4o-mini', promptTokens: 4000, completionTokens: 0 },
    })
    const { execution, steps } = await runGraph(
      [
        node('t', 'trigger-manual'),
        node('ai', 'ai-prompt', { prompt: 'spend' }),
        // No url — the HTTP runner throws, failing the run after the AI call.
        node('boom', 'action-http', {}),
      ],
      [
        { id: 'e1', source: 't', target: 'ai' },
        { id: 'e2', source: 'ai', target: 'boom' },
      ]
    )
    expect(execution.status).toBe('failed')
    expect(stepFor(steps, 'ai').cost_micro_usd).toBe(600)
    expect(execution.cost_micro_usd).toBe(600)
  })

  it('records an unpriced model as a visible zero, not a silent one', async () => {
    mockCallAiService.mockResolvedValue({
      text: 'x',
      usage: { model: 'brand-new-model', promptTokens: 5000, completionTokens: 5000 },
    })
    const { steps } = await runGraph([
      node('t', 'trigger-manual'),
      node('ai', 'ai-prompt', { prompt: 'x' }),
    ], [{ id: 'e1', source: 't', target: 'ai' }])

    const usage = JSON.parse(stepFor(steps, 'ai').usage_json)
    expect(usage.priced).toBe(false)
    expect(usage.promptTokens).toBe(5000) // the tokens are still recorded
    expect(stepFor(steps, 'ai').cost_micro_usd).toBe(0)
  })

  it('counts an external call without pricing it, and prices a declared rate', async () => {
    const { steps } = await runGraph(
      [
        node('t', 'trigger-manual'),
        node('h1', 'action-http', { url: 'https://example.test/a' }),
        node('h2', 'action-http', { url: 'https://example.test/b', costPerCall: 0.01 }),
      ],
      [
        { id: 'e1', source: 't', target: 'h1' },
        { id: 'e2', source: 'h1', target: 'h2' },
      ],
      { dryRun: true } // dry-run: the HTTP runners report what they'd send
    )
    expect(stepFor(steps, 'h1').cost_micro_usd).toBe(0)
    expect(JSON.parse(stepFor(steps, 'h1').usage_json)).toMatchObject({ kind: 'call', priced: false })
    expect(stepFor(steps, 'h2').cost_micro_usd).toBe(10_000)
  })

  it('leaves unmetered steps' + ' with no cost columns at all', async () => {
    const { steps } = await runGraph([
      node('t', 'trigger-manual'),
      node('x', 'transform', { expression: '{}' }),
    ], [{ id: 'e1', source: 't', target: 'x' }])
    expect(stepFor(steps, 'x').cost_micro_usd).toBeNull()
    expect(stepFor(steps, 'x').usage_json).toBeNull()
  })

  it('never fails a run because metering failed', async () => {
    // Bookkeeping must not be able to break the thing it books.
    mockCallAiService.mockResolvedValue({
      text: 'x',
      // A usage object shaped nothing like the contract.
      usage: { model: { nested: true }, promptTokens: [1, 2, 3] },
    })
    const { execution } = await runGraph([
      node('t', 'trigger-manual'),
      node('ai', 'ai-prompt', { prompt: 'x' }),
    ], [{ id: 'e1', source: 't', target: 'ai' }])
    expect(execution.status).toBe('completed')
  })
})
