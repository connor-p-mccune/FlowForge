// JUnit XML rendering for `flowforge test --junit <file>`. JUnit's schema is
// the lingua franca of CI test reporting — GitHub, GitLab, Jenkins, and
// Buildkite all render it natively — so a workflow's scenario suite can show
// up beside the codebase's own unit tests in the same pipeline UI.
//
// One <testsuite> per workflow; one <testcase> per scenario. A failed
// scenario carries a <failure> whose body lists exactly the assertions that
// didn't hold (expression, optional description, and the evaluation error if
// it couldn't even be evaluated) — the same detail the terminal output
// prints, machine-readable.

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// data is the response of POST /api/v1/workflows/:id/tests/run:
// { total, failed, ok, scenarios: [{ name, passed, runStatus,
//   assertions: [{ expression, description?, passed, error? }] }] }
function junitXml(workflowId, data) {
  const scenarios = data.scenarios || []
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>']
  lines.push(
    `<testsuite name="flowforge:${escapeXml(workflowId)}" tests="${data.total || 0}" failures="${data.failed || 0}">`
  )
  for (const s of scenarios) {
    const name = escapeXml(s.name)
    if (s.passed) {
      lines.push(`  <testcase classname="${escapeXml(workflowId)}" name="${name}"/>`)
      continue
    }
    const failing = (s.assertions || []).filter((a) => !a.passed)
    const summary =
      s.runStatus && s.runStatus !== 'completed'
        ? `run ${s.runStatus}`
        : `${failing.length} assertion${failing.length === 1 ? '' : 's'} failed`
    const detail = failing
      .map((a) => {
        const desc = a.description ? ` (${a.description})` : ''
        const err = a.error ? ` — ${a.error}` : ''
        return `${a.expression}${desc}${err}`
      })
      .join('\n')
    lines.push(`  <testcase classname="${escapeXml(workflowId)}" name="${name}">`)
    lines.push(`    <failure message="${escapeXml(summary)}">${escapeXml(detail)}</failure>`)
    lines.push('  </testcase>')
  }
  lines.push('</testsuite>')
  return lines.join('\n') + '\n'
}

module.exports = { junitXml }
