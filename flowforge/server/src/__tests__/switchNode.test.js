// Tests for the Switch node runner: ordered, first-match routing over labelled
// FXL cases, with a default when none match.

const runSwitch = require('../services/nodeRunners/switch')

describe('switch node runner', () => {
  const cases = [
    { label: 'high', expression: 'amount > 1000' },
    { label: 'mid', expression: 'amount > 100' },
    { label: 'low', expression: 'amount >= 0' },
  ]

  it('routes to the first matching case (order matters)', async () => {
    const out = await runSwitch({ cases }, { amount: 5000 })
    expect(out.result).toBe('high')
    expect(out.matched).toBe(true)
    expect(out.matchedIndex).toBe(0)
  })

  it('skips earlier non-matching cases', async () => {
    const out = await runSwitch({ cases }, { amount: 250 })
    expect(out.result).toBe('mid')
    expect(out.matchedIndex).toBe(1)
  })

  it('falls through to default when no case matches', async () => {
    const out = await runSwitch({ cases }, { amount: -5 })
    expect(out.result).toBe('default')
    expect(out.matched).toBe(false)
    expect(out.matchedIndex).toBe(-1)
  })

  it('exposes input fields directly and via `input`', async () => {
    const byField = await runSwitch(
      { cases: [{ label: 'open', expression: 'status == "open"' }] },
      { status: 'open' }
    )
    expect(byField.result).toBe('open')

    const byInput = await runSwitch(
      { cases: [{ label: 'open', expression: 'input.status == "open"' }] },
      { status: 'open' }
    )
    expect(byInput.result).toBe('open')
  })

  it('supports rich boolean logic and the stdlib', async () => {
    const out = await runSwitch(
      { cases: [{ label: 'urgent', expression: 'priority > 3 && contains(lower(tag), "sev")' }] },
      { priority: 5, tag: 'SEV1' }
    )
    expect(out.result).toBe('urgent')
  })

  it('throws when there are no cases', async () => {
    await expect(runSwitch({ cases: [] }, {})).rejects.toThrow(/at least one case/)
    await expect(runSwitch({}, {})).rejects.toThrow(/at least one case/)
  })

  it('throws for a case with no label or no expression', async () => {
    await expect(
      runSwitch({ cases: [{ label: '', expression: 'true' }] }, {})
    ).rejects.toThrow(/no label/)
    await expect(
      runSwitch({ cases: [{ label: 'x', expression: '  ' }] }, {})
    ).rejects.toThrow(/no expression/)
  })

  it('surfaces an invalid expression as the case that broke', async () => {
    await expect(
      runSwitch({ cases: [{ label: 'bad', expression: 'amount >' }] }, { amount: 1 })
    ).rejects.toThrow(/Switch case "bad" is invalid/)
  })

  it('surfaces a runtime evaluation error with the case label', async () => {
    await expect(
      runSwitch({ cases: [{ label: 'oops', expression: 'nope("x")' }] }, {})
    ).rejects.toThrow(/Switch case "oops" failed/)
  })
})
