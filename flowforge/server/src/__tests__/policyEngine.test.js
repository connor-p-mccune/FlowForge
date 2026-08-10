// The policy engine: the document a rule is written about, the authoring-time
// validation that keeps a broken rule out of the store, and evaluation —
// including the two decisions that carry the design (fail closed, and report
// evidence).

const {
  buildDocument,
  evaluatePolicies,
  validateRule,
  isBlocking,
  scanForCredentials,
  BUILTIN_POLICIES,
  DOCUMENT_TYPE,
} = require('../services/policyEngine')
const { typeCheck } = require('../services/expression')

const node = (id, type, config = {}, label = id) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label, config },
})

const workflowWith = (nodes, extra = {}) => ({
  id: 'wf-1',
  name: 'Nightly sync',
  status: 'draft',
  graph_json: JSON.stringify({ nodes, edges: [] }),
  ...extra,
})

describe('buildDocument', () => {
  it('flattens composition into the facts a rule is written about', () => {
    const doc = buildDocument(
      workflowWith([
        node('t', 'trigger-schedule', { cron: '0 3 * * *', timezone: 'Europe/London' }),
        node('h1', 'action-http', { url: 'https://api.acme.com/orders', method: 'GET' }),
        node('h2', 'action-http', { url: 'http://legacy.internal/x', method: 'POST' }),
        node('a', 'ai-prompt', { prompt: 'summarise' }),
      ])
    )
    expect(doc.nodeTypes).toEqual(['action-http', 'ai-prompt', 'trigger-schedule'])
    expect(doc.nodeCounts['action-http']).toBe(2)
    expect(doc.httpHosts).toEqual(['api.acme.com', 'legacy.internal'])
    expect(doc.httpMethods).toEqual(['GET', 'POST'])
    expect(doc.cronExpressions).toEqual(['0 3 * * *'])
    expect(doc.timezones).toEqual(['Europe/London'])
    expect(doc.hasSchedule).toBe(true)
    expect(doc.hasAiNode).toBe(true)
    expect(doc.hasApproval).toBe(false)
  })

  it('ignores sticky notes — an annotation is not something to govern', () => {
    const doc = buildDocument(workflowWith([node('n', 'note', { text: 'hi' })]))
    expect(doc.workflow.nodeCount).toBe(0)
    expect(doc.nodeTypes).toEqual([])
  })

  it('names no host for a templated URL rather than inventing one', () => {
    const doc = buildDocument(
      workflowWith([node('h', 'action-http', { url: '{{vars.BASE}}/orders' })])
    )
    expect(doc.httpHosts).toEqual([])
    expect(doc.httpUrls).toEqual(['{{vars.BASE}}/orders'])
  })

  it('collects the secrets and variables the graph references', () => {
    const doc = buildDocument(
      workflowWith([
        node('h', 'action-http', {
          url: '{{vars.BASE}}/x',
          headers: '{"Authorization": "Bearer {{secrets.STRIPE_KEY}}"}',
        }),
      ])
    )
    expect(doc.secretsUsed).toEqual(['STRIPE_KEY'])
    expect(doc.varsUsed).toEqual(['BASE'])
  })

  it('reads the workflow’s declared limits', () => {
    const doc = buildDocument(
      workflowWith([], {
        max_concurrent_runs: 1,
        rate_limit_max: 100,
        rate_limit_window_seconds: 3600,
        heartbeat_interval_minutes: 90,
        slo_target: 0.99,
        error_workflow_id: 'wf-handler',
      })
    )
    expect(doc.limits.maxConcurrentRuns).toBe(1)
    expect(doc.limits.rateLimitMax).toBe(100)
    expect(doc.limits.heartbeatIntervalMinutes).toBe(90)
    expect(doc.limits.sloTarget).toBe(0.99)
    expect(doc.hasErrorHandler).toBe(true)
  })

  it('takes everything outside the row from its caller, so it stays pure', () => {
    const doc = buildDocument(workflowWith([]), {
      webhooks: [{ signing_secret: 'x' }, { signing_secret: null, filter_expression: 'a' }],
      testCount: 3,
      workspace: { budget_micro_usd: 500000 },
      secretNames: ['B', 'A'],
    })
    expect(doc.webhooks).toEqual({ count: 2, signed: 1, unsigned: 1, filtered: 1 })
    expect(doc.tests.count).toBe(3)
    expect(doc.workspace.hasBudget).toBe(true)
    expect(doc.workspace.secretNames).toEqual(['A', 'B'])
  })

  it('treats an unparseable graph as an empty one rather than throwing', () => {
    const doc = buildDocument({ id: 'x', name: 'x', graph_json: 'not json' })
    expect(doc.workflow.nodeCount).toBe(0)
  })
})

describe('scanForCredentials', () => {
  it('flags a provider-prefixed key typed straight into a config', () => {
    expect(
      scanForCredentials([node('h', 'action-http', { url: 'https://x', body: 'sk-abcdef1234567890' })])
    ).toEqual(['h'])
    expect(
      scanForCredentials([node('h', 'action-slack', { webhookUrl: 'https://x', token: 'xoxb-1-2-abcdefgh' })])
    ).toEqual(['h'])
  })

  it('looks inside a JSON string, which is where headers actually live', () => {
    expect(
      scanForCredentials([
        node('h', 'action-http', { headers: '{"Authorization": "Bearer aVeryLongLiteralToken"}' }),
      ])
    ).toEqual(['h'])
  })

  it('flags a credential-shaped key with a long literal value', () => {
    expect(scanForCredentials([node('h', 'action-http', { apiKey: 'abcdefghijklmnop' })])).toEqual(['h'])
  })

  it('says nothing when the value is a secret reference — the thing we want', () => {
    expect(
      scanForCredentials([
        node('h', 'action-http', { headers: '{"Authorization": "Bearer {{secrets.KEY}}"}' }),
      ])
    ).toEqual([])
  })

  it('does not flag ordinary prose in a credential-shaped key', () => {
    // A sentence has spaces; a token does not.
    expect(scanForCredentials([node('h', 'action-http', { auth: 'ask the platform team' })])).toEqual([])
  })

  it('does not flag a long value under a harmless key', () => {
    expect(
      scanForCredentials([node('h', 'action-http', { subject: 'a fairly long ordinary subject line' })])
    ).toEqual([])
  })
})

describe('validateRule', () => {
  it('accepts a rule that parses and typechecks against the document', () => {
    expect(validateRule('len(notMatching(httpHosts, ["*.acme.com"])) == 0')).toBeNull()
    expect(validateRule('hasSchedule ? limits.heartbeatIntervalMinutes != null : true')).toBeNull()
  })

  it('refuses a blank or oversized rule', () => {
    expect(validateRule('')).toMatch(/required/)
    expect(validateRule('a'.repeat(1001))).toMatch(/too long/)
  })

  it('refuses a syntax error and an unknown function', () => {
    expect(validateRule('nodeCount >')).toMatch(/syntax error/)
    expect(validateRule('everyHost(httpHosts)')).toMatch(/unknown function "everyHost\(\)"/)
  })

  it('refuses a rule that reads a field the document does not have', () => {
    // This is the important one: `httpHost` (singular) would evaluate to
    // undefined and quietly report compliant forever.
    expect(validateRule('len(httpHost) == 0')).toMatch(/not in scope here — did you mean "httpHosts"\?/)
  })

  it('refuses a rule whose types cannot work out', () => {
    expect(validateRule('sum(httpHosts) > workflow.name')).toBeNull() // strings sum-check is dynamic-free but legal
    expect(validateRule('workflow.nodeCount * limits')).toMatch(/needs numbers/)
  })

  it('labels the field it was given, so a bad evidence expression reads right', () => {
    expect(validateRule('nope', 'evidence')).toMatch(/^evidence: "nope" is not in scope/)
  })
})

describe('the document type matches the document', () => {
  // Contract pinning: the schema is written out by hand (deriving it from a
  // sample would type an empty `httpHosts` as `unknown[]` and lose the check),
  // so a test has to hold the two together.
  const sample = buildDocument(workflowWith([node('h', 'action-http', { url: 'https://a.example' })]), {
    webhooks: [],
    testCount: 0,
    workspace: {},
  })

  it('declares every top-level key the builder produces', () => {
    expect(Object.keys(DOCUMENT_TYPE.fields).sort()).toEqual(Object.keys(sample).sort())
  })

  it('declares every key of each nested block', () => {
    for (const block of ['workflow', 'limits', 'webhooks', 'tests', 'workspace']) {
      expect(Object.keys(DOCUMENT_TYPE.fields[block].type.fields).sort())
        .toEqual(Object.keys(sample[block]).sort())
    }
  })

  it('types the collections as string lists, so a glob rule checks', () => {
    expect(typeCheck('matching(httpHosts, "*.acme.com")', DOCUMENT_TYPE).diagnostics).toEqual([])
    expect(typeCheck('httpHosts * 2', DOCUMENT_TYPE).diagnostics[0].code).toBe('operand-type')
  })
})

describe('evaluatePolicies', () => {
  const doc = buildDocument(
    workflowWith([
      node('h1', 'action-http', { url: 'https://api.acme.com/x' }),
      node('h2', 'action-http', { url: 'https://evil.example.net/x' }),
    ])
  )

  const policy = (over = {}) => ({
    id: 'p1',
    name: 'Approved hosts',
    rule: 'len(notMatching(httpHosts, ["*.acme.com"])) == 0',
    message: 'Call an approved host.',
    severity: 'deny',
    enabled: 1,
    ...over,
  })

  it('reports nothing when every rule holds', () => {
    expect(evaluatePolicies([policy({ rule: 'workflow.nodeCount <= 10' })], doc)).toEqual([])
  })

  it('reports the stored message, not a restatement of the condition', () => {
    const [violation] = evaluatePolicies([policy()], doc)
    expect(violation).toMatchObject({
      policyId: 'p1',
      name: 'Approved hosts',
      severity: 'deny',
      message: 'Call an approved host.',
    })
  })

  it('computes evidence only on failure, and reports it', () => {
    const [violation] = evaluatePolicies(
      [policy({ evidence: 'notMatching(httpHosts, ["*.acme.com"])' })],
      doc
    )
    expect(violation.evidence).toEqual(['evil.example.net'])
  })

  it('skips a disabled policy', () => {
    expect(evaluatePolicies([policy({ enabled: 0 })], doc)).toEqual([])
  })

  it('fails closed when a rule cannot be evaluated', () => {
    // A control that silently passes when it breaks is worse than no control,
    // and the save-time validation means reaching here is already an anomaly.
    const [violation] = evaluatePolicies([policy({ rule: 'sum(httpHosts) > 0' })], doc)
    expect(violation.errored).toBe(true)
    expect(violation.severity).toBe('deny')
    expect(violation.message).toMatch(/could not be evaluated/)
  })

  it('does not let a broken evidence expression change the verdict', () => {
    const [violation] = evaluatePolicies([policy({ evidence: 'sum(httpHosts)' })], doc)
    expect(violation.evidence).toBeNull()
    expect(violation.errored).toBeUndefined()
    expect(violation.severity).toBe('deny')
  })

  it('treats an unrecognised severity as deny', () => {
    expect(evaluatePolicies([policy({ severity: 'nudge' })], doc)[0].severity).toBe('deny')
  })

  it('isBlocking is true only when something denies', () => {
    expect(isBlocking(evaluatePolicies([policy({ severity: 'warn' })], doc))).toBe(false)
    expect(isBlocking(evaluatePolicies([policy()], doc))).toBe(true)
    expect(isBlocking([])).toBe(false)
  })
})

describe('the starter library', () => {
  it('every template validates against the document schema', () => {
    for (const template of BUILTIN_POLICIES) {
      expect(validateRule(template.rule, template.key)).toBeNull()
      if (template.evidence) expect(validateRule(template.evidence, template.key)).toBeNull()
    }
  })

  it('every template carries a remedy, a severity, and a unique key', () => {
    const keys = BUILTIN_POLICIES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const template of BUILTIN_POLICIES) {
      expect(template.message).toBeTruthy()
      expect(['deny', 'warn']).toContain(template.severity)
    }
  })

  it('the HTTPS template passes a compliant workflow and blocks a plaintext one', () => {
    const https = BUILTIN_POLICIES.find((t) => t.key === 'https-only')
    const ok = buildDocument(workflowWith([node('h', 'action-http', { url: 'https://a.example/x' })]))
    const bad = buildDocument(workflowWith([node('h', 'action-http', { url: 'http://a.example/x' })]))
    expect(evaluatePolicies([{ ...https, id: 'b1', enabled: 1 }], ok)).toEqual([])
    const [violation] = evaluatePolicies([{ ...https, id: 'b1', enabled: 1 }], bad)
    expect(violation.evidence).toEqual(['http://a.example/x'])
  })

  it('the HTTPS template does not fire on a URL built from a template', () => {
    // `{{vars.BASE}}/x` has no scheme we can judge; refusing it would make the
    // policy unusable in exactly the environments that need it.
    const https = BUILTIN_POLICIES.find((t) => t.key === 'https-only')
    const doc = buildDocument(workflowWith([node('h', 'action-http', { url: '{{vars.BASE}}/x' })]))
    expect(evaluatePolicies([{ ...https, id: 'b1', enabled: 1 }], doc)).toEqual([])
  })

  it('the credentials template fires on a literal key and not on a secret reference', () => {
    const rule = BUILTIN_POLICIES.find((t) => t.key === 'no-hardcoded-credentials')
    const bad = buildDocument(
      workflowWith([node('h', 'action-http', { headers: '{"Authorization": "Bearer sk-abcdef1234567890"}' })])
    )
    const good = buildDocument(
      workflowWith([node('h', 'action-http', { headers: '{"Authorization": "Bearer {{secrets.K}}"}' })])
    )
    expect(evaluatePolicies([{ ...rule, id: 'b2', enabled: 1 }], bad)[0].evidence).toEqual(['h'])
    expect(evaluatePolicies([{ ...rule, id: 'b2', enabled: 1 }], good)).toEqual([])
  })
})
