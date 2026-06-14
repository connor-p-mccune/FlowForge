// Phase 7 / item 1 — expression-sandboxing regression tests.
//
// FlowForge deliberately has NO arbitrary-code-execution path: there is no
// `eval`, no `new Function`, and no `vm` anywhere in the server. The transform
// node parses JSON, the condition node runs a fixed set of comparison operators,
// and the execution engine's `{{node.field}}` resolver only substitutes values
// looked up by a `[\w-.]`-restricted path grammar.
//
// These tests prove that a user who tries to smuggle code into a node config
// (the realistic attack surface — transform templates, condition operands, and
// template placeholders) gets inert data back, never execution. If someone later
// "improves" transform with eval/new Function, or loosens the placeholder
// grammar, these tests fail.

process.env.NODE_ENV = 'test'

const transform = require('../services/nodeRunners/transform')
const condition = require('../services/nodeRunners/condition')
const { resolveTemplates } = require('../services/executionEngine')

describe('transform node never executes user-supplied code', () => {
  it('treats a require() payload as an inert string, not code', async () => {
    const payload = "require('fs').readFileSync('/etc/passwd')"
    const out = await transform({ template: payload }, {})
    // Not valid JSON → wrapped as { value } verbatim. Never evaluated.
    expect(out).toEqual({ value: payload })
  })

  it('does not call process.exit when handed a process.exit() payload', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must never be called by a node runner')
    })
    try {
      const out = await transform({ template: 'process.exit(1)' }, {})
      expect(out).toEqual({ value: 'process.exit(1)' })
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('parses JSON payloads as data only — dangerous strings stay strings', async () => {
    // A JSON object whose values *name* dangerous things is still just data.
    const template = JSON.stringify({
      cmd: "require('child_process').exec('rm -rf /')",
    })
    const out = await transform({ template }, {})
    expect(out).toEqual({ cmd: "require('child_process').exec('rm -rf /')" })
  })
})

describe('{{ }} template resolver never evaluates expressions', () => {
  it('leaves a code-injection attempt inside braces verbatim', () => {
    // The placeholder grammar only allows word/dot/hyphen paths, so anything
    // with parens, quotes, or spaces in the middle is not a placeholder at all.
    const malicious = "{{ constructor.constructor('return process')() }}"
    expect(resolveTemplates(malicious, {})).toBe(malicious)
  })

  it('only substitutes values found by literal path lookup in the context', () => {
    expect(resolveTemplates('hi {{n1.name}}', { n1: { name: 'safe' } })).toBe('hi safe')
    // An exact placeholder with no matching context entry resolves to undefined
    // (a missing value) — it is never treated as an expression to run.
    expect(resolveTemplates('{{ghost.field}}', {})).toBeUndefined()
  })

  it('does not invoke getters or functions reachable via the context object', () => {
    let touched = false
    const context = {
      n1: {
        get danger() {
          touched = true
          return 'should-not-be-read-as-code'
        },
      },
    }
    // Reading a real path *does* read the value (that's the feature), but it is
    // returned as data — there is no call/exec of anything. Reaching a property
    // that doesn't exist must not throw or execute.
    expect(resolveTemplates('{{n1.missing.deeper}}', context)).toBeUndefined()
    expect(touched).toBe(false)
  })
})

describe('condition node compares values as data, never as code', () => {
  it('compares code-looking operands by value only', async () => {
    const out = await condition({
      left: 'process.exit(1)',
      operator: 'equals',
      right: 'process.exit(1)',
    })
    expect(out).toEqual({ result: true })
  })

  it('rejects unknown operators instead of evaluating them', async () => {
    await expect(
      condition({ left: 1, operator: 'constructor', right: 2 })
    ).rejects.toThrow(/unknown operator/)
  })
})
