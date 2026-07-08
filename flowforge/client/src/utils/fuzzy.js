// Small fuzzy matcher for the command palette. Greedy forward subsequence
// matching with a simple, deterministic score: consecutive characters and
// word starts are worth more, and shorter targets edge out longer ones on
// ties — so "nsy" ranks "Nightly Sync" above "Notify Somebody Yearly".

// Characters that begin a "word" for the word-start bonus.
const BOUNDARY = /[\s\-_./]/

// Match `query` as a subsequence of `text` (case-insensitive).
// Returns { score, indices } — indices are the matched positions in `text`,
// for highlighting — or null when the query doesn't fit.
export function fuzzyMatch(query, text) {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (!q) return { score: 0, indices: [] }
  const t = String(text).toLowerCase()

  const indices = []
  let score = 0
  let searchFrom = 0
  let lastMatch = -2

  for (const ch of q) {
    const found = t.indexOf(ch, searchFrom)
    if (found === -1) return null
    if (found === lastMatch + 1) {
      score += 3 // run of consecutive matches
    } else if (found === 0 || BOUNDARY.test(t[found - 1])) {
      score += 2 // start of a word
    } else {
      score += 1
    }
    indices.push(found)
    lastMatch = found
    searchFrom = found + 1
  }

  // Prefer tighter, shorter targets when the per-character score ties, and
  // matches that start early — "sync" should rank "Sync invoices" above
  // "Nightly Sync".
  score -= t.length * 0.05
  score -= indices[0] * 0.5
  return { score, indices }
}

// Rank `items` against `query`. getText extracts the searchable string.
// Non-matching items drop out; the rest sort by score (desc), stable within
// equal scores. An empty query returns everything in original order.
export function fuzzyFilter(query, items, getText) {
  if (!query.trim()) return items.map((item) => ({ item, indices: [] }))
  return items
    .map((item, order) => {
      const match = fuzzyMatch(query, getText(item))
      return match && { item, order, ...match }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ item, indices }) => ({ item, indices }))
}

// Split `text` into segments for rendering, marking matched characters:
// [{ text, match }] — consecutive matched indices merge into one segment.
export function highlightSegments(text, indices) {
  if (!indices || indices.length === 0) return [{ text, match: false }]
  const set = new Set(indices)
  const segments = []
  let current = null
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i)
    if (current && current.match === match) {
      current.text += text[i]
    } else {
      current = { text: text[i], match }
      segments.push(current)
    }
  }
  return segments
}
