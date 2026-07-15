// SSRF protection for node runners that fetch a user-supplied URL — action-http
// (httpRequest.js) and action-slack (sendSlack.js). Without it, a workflow author
// (or, if a workflow wires the URL from {{trigger.*}}, an anonymous webhook
// caller) can point the server at internal-only addresses: cloud metadata
// (169.254.169.254), localhost, or the internal redis / ai-service hosts.
//
// Controls: restrict the scheme to http/https, resolve the hostname and reject
// any address in a private / loopback / link-local / reserved range, and re-run
// that check on every redirect hop (fetch would otherwise follow a redirect to an
// internal address without re-validating).
//
// Residual risk (documented in SECURITY.md): there is a small window between the
// DNS check here and fetch's own resolution, so a determined DNS-rebinding
// attacker could still slip through. Closing it fully needs connection-level IP
// pinning (a custom undici dispatcher); deferred for the MVP.
//
// Enforcement mirrors the rate-limiter switch: on in dev and production, but
// skipped under NODE_ENV=test by default (the runner suites hit 127.0.0.1 test
// servers) unless a suite opts in with ENABLE_SSRF_GUARD=true; DISABLE_SSRF_GUARD
// =true turns it off anywhere. Read live per call so an opt-in test can't leak.

const dns = require('dns').promises
const net = require('net')
const { withCircuit } = require('./circuitBreaker')

const MAX_REDIRECTS = 5

function enforced() {
  if (process.env.DISABLE_SSRF_GUARD === 'true') return false
  if (process.env.NODE_ENV === 'test') return process.env.ENABLE_SSRF_GUARD === 'true'
  return true
}

// True for IPv4 addresses that must never be reached from a server-side fetch:
// "this host", private, loopback, link-local (incl. the 169.254.169.254 cloud
// metadata endpoint), CGNAT, benchmarking, multicast, and reserved/broadcast.
// A malformed value fails closed (blocked).
function isBlockedIpv4(ip) {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = o
  if (a === 0) return true // 0.0.0.0/8 "this host"
  if (a === 10) return true // 10/8 private
  if (a === 127) return true // 127/8 loopback
  if (a === 169 && b === 254) return true // 169.254/16 link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 private
  if (a === 192 && b === 168) return true // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 benchmarking
  if (a >= 224) return true // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false
}

// Parse an IPv6 literal (with :: compression and/or an embedded IPv4 tail) into
// 16 bytes, or null if it isn't well-formed.
function ipv6ToBytes(ip) {
  ip = ip.split('%')[0] // drop any zone id
  // Fold a trailing dotted-quad (e.g. ::ffff:127.0.0.1) into two hextets.
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':')
    const quad = ip.slice(lastColon + 1).split('.').map(Number)
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((quad[0] << 8) | quad[1]).toString(16)
    const lo = ((quad[2] << 8) | quad[3]).toString(16)
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null
  let groups
  if (tail === null) {
    groups = head
    if (groups.length !== 8) return null
  } else {
    const missing = 8 - (head.length + tail.length)
    if (missing < 1) return null // "::" must stand in for at least one group
    groups = [...head, ...Array(missing).fill('0'), ...tail]
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null
    const val = parseInt(groups[i], 16)
    bytes[i * 2] = (val >> 8) & 0xff
    bytes[i * 2 + 1] = val & 0xff
  }
  return bytes
}

// True for IPv6 addresses that must never be reached: unspecified, loopback,
// unique-local, link-local, multicast, and any form carrying an embedded IPv4
// (mapped / NAT64) whose v4 address is itself blocked. Fails closed.
function isBlockedIpv6(ip) {
  const b = ipv6ToBytes(ip)
  if (!b) return true
  const firstTen = b.slice(0, 10).every((x) => x === 0)
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true // :: and ::1
  if (firstTen && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) // ::ffff:a.b.c.d (IPv4-mapped)
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) // 64:ff9b::/96 NAT64
  }
  if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
  if (b[0] === 0xff) return true // ff00::/8 multicast
  return false
}

function isBlockedIp(ip) {
  if (typeof ip !== 'string') return true
  if (net.isIPv4(ip)) return isBlockedIpv4(ip)
  if (net.isIPv6(ip)) return isBlockedIpv6(ip)
  return true // not a valid IP literal → block (fail closed)
}

// Parse + scheme-check a URL. Throws on anything that isn't http(s).
function assertAllowedUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('SSRF protection: invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`SSRF protection: blocked URL scheme "${url.protocol}"`)
  }
  return url
}

// Full check for one URL: allowed scheme + the host (or every address it resolves
// to) is outside the blocked ranges. Throws with a descriptive message on block.
async function assertSafeUrl(rawUrl) {
  const url = assertAllowedUrl(rawUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '') // strip brackets from an IPv6 literal

  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`SSRF protection: blocked address ${host}`)
    return url
  }

  let addresses
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new Error(`SSRF protection: could not resolve host "${host}"`)
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new Error(`SSRF protection: "${host}" resolves to blocked address ${address}`)
    }
  }
  return url
}

// Drop-in replacement for fetch() used by the side-effecting node runners. When
// enforcement is off (default in tests) it is a passthrough. When on, it walks
// redirects manually, validating each hop, so a public URL can't 30x-redirect the
// server onto an internal address. Every call runs under the target host's
// circuit breaker (circuitBreaker.js): a host that keeps failing fast-fails
// here instead of stacking timeouts across node retries and webhook attempts.
async function safeFetch(rawUrl, options = {}) {
  return withCircuit(rawUrl, () => guardedFetch(rawUrl, options))
}

async function guardedFetch(rawUrl, options = {}) {
  if (!enforced()) return fetch(rawUrl, options)

  let currentUrl = rawUrl
  let method = options.method || 'GET'
  let body = options.body
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl)
    const res = await fetch(currentUrl, { ...options, method, body, redirect: 'manual' })

    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).href
      // Mirror how agents demote to GET (and drop the body) on these redirects.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    return res
  }
  throw new Error('SSRF protection: too many redirects')
}

module.exports = { safeFetch, assertSafeUrl, assertAllowedUrl, isBlockedIp, enforced }
