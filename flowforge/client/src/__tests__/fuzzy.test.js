import { describe, it, expect } from 'vitest'
import { fuzzyMatch, fuzzyFilter, highlightSegments } from '../utils/fuzzy'

describe('fuzzyMatch', () => {
  it('matches subsequences case-insensitively', () => {
    expect(fuzzyMatch('nsy', 'Nightly Sync')).not.toBeNull()
    expect(fuzzyMatch('NIGHT', 'nightly sync')).not.toBeNull()
    expect(fuzzyMatch('xyz', 'Nightly Sync')).toBeNull()
  })

  it('returns the matched character positions', () => {
    const m = fuzzyMatch('ns', 'Nightly Sync')
    expect(m.indices).toEqual([0, 8])
  })

  it('requires characters in order', () => {
    expect(fuzzyMatch('sn', 'ns')).toBeNull()
    expect(fuzzyMatch('ns', 'ns')).not.toBeNull()
  })

  it('scores consecutive runs above scattered matches', () => {
    const consecutive = fuzzyMatch('sync', 'Sync report')
    const scattered = fuzzyMatch('sync', 'seven yellow numbered cats')
    expect(consecutive.score).toBeGreaterThan(scattered.score)
  })

  it('scores word starts above mid-word hits', () => {
    const wordStart = fuzzyMatch('as', 'alert-sender') // a + word-start s
    const midWord = fuzzyMatch('as', 'blaster') // both mid-word
    expect(wordStart.score).toBeGreaterThan(midWord.score)
  })

  it('prefers the shorter of two equally matching targets', () => {
    const short = fuzzyMatch('sync', 'Sync')
    const long = fuzzyMatch('sync', 'Synchronize everything nightly')
    expect(short.score).toBeGreaterThan(long.score)
  })

  it('ignores whitespace in the query', () => {
    expect(fuzzyMatch('night sync', 'Nightly Sync')).not.toBeNull()
  })

  it('treats an empty query as a trivial match', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] })
  })
})

describe('fuzzyFilter', () => {
  const items = [
    { name: 'Nightly Sync' },
    { name: 'Alert on failure' },
    { name: 'Sync invoices' },
  ]

  it('returns everything (original order) for a blank query', () => {
    const out = fuzzyFilter('   ', items, (i) => i.name)
    expect(out.map((r) => r.item.name)).toEqual([
      'Nightly Sync', 'Alert on failure', 'Sync invoices',
    ])
  })

  it('drops non-matches and ranks the best match first', () => {
    const out = fuzzyFilter('sync', items, (i) => i.name)
    const names = out.map((r) => r.item.name)
    expect(names).toContain('Nightly Sync')
    expect(names).toContain('Sync invoices')
    expect(names).not.toContain('Alert on failure')
    // Word-start consecutive run wins.
    expect(names[0]).toBe('Sync invoices')
  })
})

describe('highlightSegments', () => {
  it('merges consecutive matched characters into single segments', () => {
    const segs = highlightSegments('Sync', [0, 1, 2, 3])
    expect(segs).toEqual([{ text: 'Sync', match: true }])
  })

  it('splits matched and unmatched runs', () => {
    const segs = highlightSegments('Nightly', [0, 1])
    expect(segs).toEqual([
      { text: 'Ni', match: true },
      { text: 'ghtly', match: false },
    ])
  })

  it('handles no indices', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }])
  })
})
