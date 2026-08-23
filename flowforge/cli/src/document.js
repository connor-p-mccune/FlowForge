// Reading a workflow document off disk, in either of the two forms it takes:
// the JSON export, or the reviewable `.flow` text (docs/DSL.md).
//
// A `.flow` file is deliberately **not parsed here**. The CLI carries no copy
// of the grammar — unlike the signing canonicalisation, which is duplicated in
// this package because signing has to work offline with no server to trust — so
// the text goes over the wire and the server is the only thing that knows what
// the format is. Two things follow: a syntax error arrives carrying the line
// the parser found rather than one this had to re-derive, and the two can never
// drift apart on what the format means.
//
// Every command that takes a document uses this, so the format is a first-class
// input to the whole toolchain. A `.flow` file that could be imported but not
// diffed, linted, merged or previewed would be a format nobody could adopt.

const fs = require('fs')

// Is this the text form? By extension first, then by content — so a file named
// anything at all still works if it is obviously one or the other.
function looksLikeFlow(file, raw) {
  if (/\.flow$/i.test(file)) return true
  return !raw.trimStart().startsWith('{') && /^\s*workflow\s+"/m.test(raw)
}

// → { payload, isFlow } for a readable file, or { error } with a message the
// caller can print verbatim.
function readDocument(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { error: `Could not read "${file}": ${err.message}` }
  }

  if (looksLikeFlow(file, raw)) return { payload: { flow: raw }, isFlow: true, raw }

  try {
    return { payload: JSON.parse(raw), isFlow: false, raw }
  } catch (err) {
    return { error: `Could not parse "${file}": ${err.message}` }
  }
}

module.exports = { readDocument, looksLikeFlow }
