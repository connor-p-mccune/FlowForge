// Declared field redaction: keeping personal data out of what FlowForge stores.
//
// One property carries the feature, and it is the one a path-based
// implementation would fail: the declaration names a *location* but what is
// masked is the **value**, so an email declared once is scrubbed everywhere it
// subsequently appears — including in a response a third party echoed it back
// in. A version that scrubbed only the declared location would look identical in
// the trigger step and leak in every other row.

process.env.JWT_SECRET = 'test-secret'
process.env.DATABASE_PATH = ':memory:'
process.env.NODE_ENV = 'test'
process.env.EXEC_RETRY_BASE_MS = '1'

const { v4: uuidv4 } = require('uuid')
const db = require('../config/database')
const redaction = require('../services/redaction')
const { runExecution } = require('../services/executionEngine')
const { lintGraph } = require('../services/workflowLinter')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})
const edge = (source, target) => ({ id: `${source}-${target}`, source, target })

const PAYLOAD = {
  email: 'ada@example.com',
  customer: { name: 'Ada Lovelace', address: { line1: '12 Analytical Way' } },
  orderId: 'ord-8891',
  tags: ['vip', 'newsletter'],
}

let userId
let workspaceId

beforeAll(() => {
  userId = uuidv4()
  workspaceId = uuidv4()
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, `${userId}@test.com`, 'x', 'T', now)
  db.prepare(
    'INSERT INTO workspaces (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(workspaceId, 'WS', userId, now, now)
})

describe('parsing a declaration', () => {
  it('keeps well-formed paths and drops everything else', () => {
    expect(
      redaction.parseRedactions([
        'email',
        'customer.address.line1',
        '{{hook.email}}', // what the data picker produces
        '  spaced  ',
        'email', // duplicate
        'bad path!',
        42,
        null,
      ])
    ).toEqual(['email', 'customer.address.line1', 'hook.email', 'spaced'])
  })

  it('reads a stored JSON column, tolerating a corrupt one', () => {
    expect(redaction.parseRedactions('["email"]')).toEqual(['email'])
    expect(redaction.parseRedactions('not json')).toEqual([])
    expect(redaction.parseRedactions(null)).toEqual([])
    expect(redaction.parseRedactions('{"email":true}')).toEqual([])
  })

  it('is bounded, because the scrubber costs values × strings per run', () => {
    const many = Array.from({ length: redaction.MAX_PATHS + 20 }, (_, i) => `f${i}`)
    expect(redaction.parseRedactions(many)).toHaveLength(redaction.MAX_PATHS)
  })
})

describe('resolving values', () => {
  const values = (paths, triggerNodeIds = new Set(['hook'])) =>
    redaction.valuesFor(paths, { triggerPayload: PAYLOAD, triggerNodeIds })

  it('reads a field directly off the payload', () => {
    expect(values(['email'])).toEqual(['ada@example.com'])
  })

  it('accepts the trigger-node spelling every other reference uses', () => {
    expect(values(['hook.email'])).toEqual(['ada@example.com'])
    // …and only strips a head that really is a trigger.
    expect(values(['other.email'], new Set(['hook']))).toEqual([])
  })

  it('collects every string inside a declared object', () => {
    // Declaring `customer` should mask the name and the address inside it — the
    // alternative is a declaration per leaf, which is how a field gets missed.
    expect(values(['customer']).sort()).toEqual(['12 Analytical Way', 'Ada Lovelace'])
    expect(values(['tags']).sort()).toEqual(['newsletter', 'vip'])
  })

  it('contributes nothing for a field this run did not carry', () => {
    // Normal rather than an error: an optional field is absent on the runs that
    // do not have it.
    expect(values(['nope', 'customer.missing'])).toEqual([])
  })

  it('deduplicates, so the scrubber does not replace twice', () => {
    expect(values(['email', 'hook.email'])).toEqual(['ada@example.com'])
  })
})

describe('a run', () => {
  function seed(graph, redact) {
    const wfId = uuidv4()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO workflows (id, workspace_id, name, graph_json, redact_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(wfId, workspaceId, 'WF', JSON.stringify(graph), redact, userId, now, now)
    const execId = uuidv4()
    // The payload rides on the row, the way a webhook delivery's does — which
    // is also what a replay reads, so the declaration has to work from it.
    db.prepare(
      `INSERT INTO executions (id, workflow_id, status, trigger_type, trigger_data, created_at)
       VALUES (?, ?, 'pending', 'webhook', ?, ?)`
    ).run(execId, wfId, JSON.stringify(PAYLOAD), now)
    return execId
  }

  // hook → transform, which copies the email into a field of its own. The
  // transform's output is a *different* location holding the same value, which
  // is exactly what a path-based implementation would miss.
  const GRAPH = {
    nodes: [
      node('hook', 'trigger-webhook'),
      node('shape', 'transform', {
        template: '{"to": "{{hook.email}}", "who": "{{hook.customer.name}}", "ref": "{{hook.orderId}}"}',
      }),
    ],
    edges: [edge('hook', 'shape')],
  }

  const stepsOf = (execId) =>
    db.prepare('SELECT node_id, output_json FROM execution_steps WHERE execution_id = ?').all(execId)

  it('masks a declared value everywhere it lands, not just where it was declared', async () => {
    const execId = seed(GRAPH, JSON.stringify(['email', 'customer.name']))
    await runExecution(execId, { publish: () => {} })

    const rows = Object.fromEntries(stepsOf(execId).map((s) => [s.node_id, s.output_json]))
    // The trigger's own step, where the value arrived…
    expect(rows.hook).not.toContain('ada@example.com')
    expect(rows.hook).toContain('••••••')
    // …and the downstream node that copied it into a field of another name.
    expect(rows.shape).not.toContain('ada@example.com')
    expect(rows.shape).not.toContain('Ada Lovelace')
    // Everything undeclared is untouched: this scrubs what was named, not
    // everything that looks personal.
    expect(rows.shape).toContain('ord-8891')
  })

  it('publishes the masked value too, so a watching canvas never sees it', async () => {
    const published = []
    const execId = seed(GRAPH, JSON.stringify(['email']))
    await runExecution(execId, { publish: (p) => published.push(p) })

    const serialised = JSON.stringify(published)
    expect(serialised).not.toContain('ada@example.com')
    expect(serialised).toContain('••••••')
  })

  it('changes nothing for a workflow that declared none', async () => {
    const execId = seed(GRAPH, null)
    await runExecution(execId, { publish: () => {} })
    const rows = stepsOf(execId)
    expect(JSON.stringify(rows)).toContain('ada@example.com')
  })
})

describe('linting a declaration', () => {
  const graph = {
    nodes: [node('hook', 'trigger-webhook'), node('call', 'action-http', { url: 'https://x/y' })],
    edges: [edge('hook', 'call')],
  }

  it('reports a declaration that names a node output, which can never match', () => {
    // The worst failure this feature has is a rule that silently matches
    // nothing, because the author believes the field is being scrubbed.
    const found = lintGraph(graph, { redact: JSON.stringify(['call.body.email']) }).find(
      (i) => i.message.includes('Redaction')
    )
    expect(found).toMatchObject({ severity: 'error' })
    expect(found.message).toMatch(/resolved before the run/)
  })

  it('says nothing about a trigger field, spelled either way', () => {
    for (const declared of [['email'], ['hook.email'], ['customer.address']]) {
      const issues = lintGraph(graph, { redact: JSON.stringify(declared) })
      expect(issues.filter((i) => i.message.includes('Redaction'))).toEqual([])
    }
  })
})
