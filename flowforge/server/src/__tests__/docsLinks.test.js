// Every internal link in the documentation resolves.
//
// Thirty-one design records that cross-reference each other constantly, and the
// links are the only thing making them one document rather than thirty-one. A
// broken one is not cosmetic: it is a reader following an argument to the place
// it is finished and arriving nowhere, which is worse than the argument having
// stopped short in the first place.
//
// The drift goes one way, like the OpenAPI and CLI-usage guardrails beside it: a
// heading gets reworded, and the four other records pointing at it are the step
// nobody thinks of. Nothing else in the repository would ever notice.
//
// Only *internal* links are checked. An external URL that 404s is somebody
// else's deploy, and a test suite that made the build depend on the public
// internet would fail for reasons that have nothing to do with this repository.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..', '..')
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.venv', '__pycache__'])

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) markdownFiles(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

// GitHub's slugger, which is not quite the obvious one: lowercase, drop
// anything that is not a letter, digit, space, hyphen or underscore, then turn
// *each* space into a hyphen. That last step is why "Sets & patterns" anchors
// as `sets--patterns` — the removed ampersand leaves two spaces behind, and
// collapsing them would make this check reject links that work.
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-')

const anchorCache = new Map()
function anchors(file) {
  if (anchorCache.has(file)) return anchorCache.get(file)
  const found = new Set()
  let fenced = false
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // A `# comment` inside a code fence is not a heading, and several records
    // print shell sessions that contain them.
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^#{1,6}\s+(.*?)\s*$/.exec(line)
    if (match) found.add(slug(match[1]))
  }
  anchorCache.set(file, found)
  return found
}

const LINK = /\[[^\]]*\]\((?!https?:\/\/)(?!mailto:)([^)\s]+)\)/g

describe('documentation links', () => {
  const files = markdownFiles(ROOT)

  it('finds the documentation at all, so the check cannot pass by matching nothing', () => {
    // The failure mode of every source-scanning check: a walk that stops
    // finding files turns every assertion below into a tautology.
    expect(files.length).toBeGreaterThan(20)
    const linked = files.reduce((n, f) => n + (fs.readFileSync(f, 'utf8').match(LINK) || []).length, 0)
    expect(linked).toBeGreaterThan(100)
  })

  it('points every internal link at a file that exists', () => {
    const broken = []
    for (const file of files) {
      for (const [, target] of fs.readFileSync(file, 'utf8').matchAll(LINK)) {
        if (target.startsWith('#')) continue
        const [filePart] = target.split('#')
        const dest = path.resolve(path.dirname(file), filePart)
        if (!fs.existsSync(dest)) broken.push(`${path.relative(ROOT, file)} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('points every anchor at a heading that exists', () => {
    // The half that actually rots. A file rename breaks a build somewhere; a
    // reworded heading breaks nothing and nobody finds out.
    const broken = []
    for (const file of files) {
      for (const [, target] of fs.readFileSync(file, 'utf8').matchAll(LINK)) {
        const [filePart, fragment] = target.split('#')
        if (!fragment) continue
        const dest = filePart ? path.resolve(path.dirname(file), filePart) : file
        if (!dest.endsWith('.md') || !fs.existsSync(dest)) continue
        if (!anchors(dest).has(fragment)) broken.push(`${path.relative(ROOT, file)} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('indexes every design record, so none is written and orphaned', () => {
    // A record nobody links to is a record nobody reads, and the index is the
    // only route into most of them.
    const docsDir = path.join(ROOT, 'docs')
    const index = fs.readFileSync(path.join(docsDir, 'README.md'), 'utf8')
    const orphans = fs
      .readdirSync(docsDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .filter((f) => !index.includes(`(./${f})`))
    expect(orphans).toEqual([])
  })
})
