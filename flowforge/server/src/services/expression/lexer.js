// Lexer for FXL, FlowForge's safe expression language. Turns a source string
// into a flat token stream the parser consumes. Hand-rolled on purpose: the
// grammar is small enough that a scanner is a few switch statements, and it
// keeps the whole engine dependency-free and free of any `eval`/`RegExp`-driven
// interpretation of user input — the same tenet the rest of the server holds.
//
// Token kinds: number, string, boolean, null, ident, op, punct, eof. Each token
// carries its source `position` so a syntax error can point at the offending
// character.

const { ExpressionError } = require('./errors')

// Multi-character operators are matched before their single-character prefixes,
// so `<=` never lexes as `<` then `=`. Order within each length doesn't matter.
const OPERATORS = [
  '===', '!==',
  '==', '!=', '<=', '>=', '&&', '||',
  '<', '>', '+', '-', '*', '/', '%', '!', '?', ':',
]

// Word operators read more naturally than symbols in a rules editor
// (`status == "open" and amount > 100`). They lex as ident first, then the
// parser treats these reserved spellings as their symbolic equivalents.
const WORD_OPERATORS = { and: '&&', or: '||', not: '!' }

const KEYWORDS = { true: 'boolean', false: 'boolean', null: 'null' }

function isDigit(ch) {
  return ch >= '0' && ch <= '9'
}

// Identifiers accept the usual programming-language set plus `$`, so scope keys
// like `$index` are expressible.
function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$'
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch)
}

function tokenize(source) {
  if (typeof source !== 'string') {
    throw new ExpressionError('Expression must be a string')
  }
  const tokens = []
  let i = 0
  const n = source.length

  const push = (type, value, position) => tokens.push({ type, value, position })

  while (i < n) {
    const ch = source[i]

    // Whitespace (including newlines — expressions may span lines).
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    // Numbers: integer, decimal, and scientific-notation forms.
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1]))) {
      const start = i
      while (i < n && isDigit(source[i])) i++
      if (source[i] === '.') {
        i++
        while (i < n && isDigit(source[i])) i++
      }
      if (source[i] === 'e' || source[i] === 'E') {
        i++
        if (source[i] === '+' || source[i] === '-') i++
        if (!isDigit(source[i])) {
          throw new ExpressionError('Malformed number: exponent has no digits', start)
        }
        while (i < n && isDigit(source[i])) i++
      }
      push('number', Number(source.slice(start, i)), start)
      continue
    }

    // Strings: single- or double-quoted, with the usual backslash escapes. No
    // interpolation — a string is inert data, never re-parsed.
    if (ch === '"' || ch === "'") {
      const start = i
      const quote = ch
      i++
      let value = ''
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          const next = source[i + 1]
          switch (next) {
            case 'n': value += '\n'; break
            case 't': value += '\t'; break
            case 'r': value += '\r'; break
            case '\\': value += '\\'; break
            case '"': value += '"'; break
            case "'": value += "'"; break
            case '/': value += '/'; break
            default:
              if (next === undefined) {
                throw new ExpressionError('Unterminated string', start)
              }
              // Unknown escape keeps the literal character, matching a
              // forgiving reading of user-authored strings.
              value += next
          }
          i += 2
          continue
        }
        value += source[i]
        i++
      }
      if (i >= n) throw new ExpressionError('Unterminated string', start)
      i++ // closing quote
      push('string', value, start)
      continue
    }

    // Identifiers, keywords (true/false/null), and word operators (and/or/not).
    if (isIdentStart(ch)) {
      const start = i
      while (i < n && isIdentPart(source[i])) i++
      const word = source.slice(start, i)
      if (Object.prototype.hasOwnProperty.call(WORD_OPERATORS, word)) {
        push('op', WORD_OPERATORS[word], start)
      } else if (Object.prototype.hasOwnProperty.call(KEYWORDS, word)) {
        if (KEYWORDS[word] === 'boolean') push('boolean', word === 'true', start)
        else push('null', null, start)
      } else if (word === 'in') {
        push('op', 'in', start)
      } else {
        push('ident', word, start)
      }
      continue
    }

    // Grouping / member / call / list / object punctuation. (":" stays an
    // operator — the ternary parser consumes it there — and doubles as the
    // key/value separator inside an object literal.)
    if (
      ch === '(' || ch === ')' || ch === '[' || ch === ']' ||
      ch === '{' || ch === '}' || ch === '.' || ch === ','
    ) {
      push('punct', ch, i)
      i++
      continue
    }

    // Multi-then-single-character operators.
    const op = OPERATORS.find((o) => source.startsWith(o, i))
    if (op) {
      push('op', op, i)
      i += op.length
      continue
    }

    throw new ExpressionError(`Unexpected character "${ch}"`, i)
  }

  push('eof', null, n)
  return tokens
}

module.exports = { tokenize }
