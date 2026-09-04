// The test counts the README claims.
//
// A number in a README is exactly the kind of thing that goes quietly wrong:
// nothing reads it, nothing depends on it, and it is the first thing somebody
// evaluating the repository checks. This session found it claiming 184 server
// suites against an actual 195, which had been drifting for a while.
//
// Only the **file** counts are checked, and that limit is the honest one. How
// many assertions a suite contains cannot be known without running it, and a
// test that counted `it(` call sites would be wrong the moment somebody wrote
// an `it.each` — reporting a precise number derived from a bad proxy is worse
// than reporting none. The file counts are exact, they move whenever the test
// counts do, and they are what catches "nobody updated this".

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

const countFiles = (dir, pattern) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => pattern.test(f)).length

describe('the counts in the README', () => {
  it('finds the claim at all, so the check cannot pass by matching nothing', () => {
    expect(readme).toMatch(/Everything above is covered by tests/)
  })

  it('states the number of server suites the repository has', () => {
    const actual = countFiles('server/src/__tests__', /\.test\.js$/)
    expect(readme).toContain(`**${actual} server suites`)
  })

  it('states the number of client test files the repository has', () => {
    const actual = countFiles('client/src/__tests__', /\.test\.jsx?$/)
    // The claim wraps across a line in the README, so the number and its noun
    // are matched with the newline allowed between them.
    expect(readme).toMatch(new RegExp(String(actual) + '\\s+client files'))
  })

  it('states the number of CLI test files the repository has', () => {
    const actual = countFiles('cli/test', /\.test\.js$/)
    expect(readme).toContain(`${actual} CLI files`)
  })
})
