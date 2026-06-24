process.env.NODE_ENV = 'test'

const { isBlockedIp, assertAllowedUrl, assertSafeUrl, enforced } = require('../services/ssrfGuard')

describe('ssrfGuard.isBlockedIp', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    'not-an-ip', '',
  ]
  const allowed = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    '172.15.0.1', '172.32.0.1', '192.167.0.1', '100.63.0.1', '100.128.0.1',
    '2606:2800:220:1:248:1893:25c8:1946',
  ]

  it.each(blocked)('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true))
  it.each(allowed)('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false))
})

describe('ssrfGuard.assertAllowedUrl (scheme restriction)', () => {
  it('allows http and https', () => {
    expect(assertAllowedUrl('http://example.com').protocol).toBe('http:')
    expect(assertAllowedUrl('https://example.com').protocol).toBe('https:')
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow(/scheme/)
    expect(() => assertAllowedUrl('ftp://host/x')).toThrow(/scheme/)
    expect(() => assertAllowedUrl('gopher://host')).toThrow(/scheme/)
  })

  it('rejects a malformed URL', () => {
    expect(() => assertAllowedUrl('http://')).toThrow(/invalid URL/)
  })
})

describe('ssrfGuard.assertSafeUrl', () => {
  it('rejects IP-literal internal targets', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow(/blocked address/)
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked/)
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow(/blocked/)
    await expect(assertSafeUrl('http://10.1.2.3/')).rejects.toThrow(/blocked/)
  })

  it('rejects a hostname that resolves to a blocked address (localhost)', async () => {
    await expect(assertSafeUrl('http://localhost/')).rejects.toThrow(/blocked/)
  })

  it('allows a public IP literal (no DNS lookup needed)', async () => {
    await expect(assertSafeUrl('http://8.8.8.8/')).resolves.toBeDefined()
  })
})

describe('ssrfGuard.enforced', () => {
  it('is off under NODE_ENV=test by default', () => {
    expect(enforced()).toBe(false)
  })

  it('can be switched on with ENABLE_SSRF_GUARD', () => {
    process.env.ENABLE_SSRF_GUARD = 'true'
    try {
      expect(enforced()).toBe(true)
    } finally {
      delete process.env.ENABLE_SSRF_GUARD
    }
  })
})

describe('node runners reject blocked URLs when the guard is enforced', () => {
  let httpRequest
  let sendSlack

  beforeAll(() => {
    process.env.ENABLE_SSRF_GUARD = 'true'
    httpRequest = require('../services/nodeRunners/httpRequest')
    sendSlack = require('../services/nodeRunners/sendSlack')
  })

  afterAll(() => {
    delete process.env.ENABLE_SSRF_GUARD
  })

  it('action-http refuses the cloud metadata endpoint', async () => {
    await expect(
      httpRequest({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' }, {})
    ).rejects.toThrow(/SSRF/)
  })

  it('action-http refuses a private address', async () => {
    await expect(httpRequest({ url: 'http://10.0.0.1/' }, {})).rejects.toThrow(/SSRF/)
  })

  it('action-slack refuses a private webhook URL', async () => {
    await expect(
      sendSlack({ webhookUrl: 'http://127.0.0.1:6379/', text: 'x' }, {})
    ).rejects.toThrow(/SSRF/)
  })

  it('a dry run still reports without firing or blocking', async () => {
    const out = await httpRequest({ url: 'http://10.0.0.1/' }, {}, true)
    expect(out.dryRun).toBe(true)
  })
})
