// flowforge keygen [--out <prefix>] — mint an Ed25519 key pair for signing
// workflow definitions.
//
// Offline by design: it talks to no server, because a signing key that has been
// near one is a signing key somebody has to reason about. The private half never
// leaves the machine that made it; the public half is what gets pasted into a
// workspace's trust store.
//
// Writes `<prefix>.key` at mode 0600 and `<prefix>.pub`, and refuses to
// overwrite either — silently replacing a signing key is how a release stops
// verifying with no commit behind it.

const fs = require('fs')
const path = require('path')
const { bold, gray, green, red, cyan } = require('../format')
const { generateKeyPair } = require('../signing')

module.exports = async function keygen(args, ctx) {
  const prefix = args.flags.out || path.join(process.cwd(), 'flowforge-signing')
  const privatePath = `${prefix}.key`
  const publicPath = `${prefix}.pub`

  for (const file of [privatePath, publicPath]) {
    if (fs.existsSync(file)) {
      ctx.log(red(`${file} already exists — refusing to overwrite a signing key.`))
      return 1
    }
  }

  const pair = generateKeyPair()
  try {
    // 0600 on the private half. Best-effort: Windows ignores the mode, which is
    // why it is set at creation rather than checked afterwards.
    fs.writeFileSync(privatePath, pair.privateKey, { mode: 0o600 })
    fs.writeFileSync(publicPath, pair.publicKey)
  } catch (err) {
    ctx.log(red(`Could not write the key pair: ${err.message}`))
    return 1
  }

  ctx.log(green('✓ Key pair generated.'))
  ctx.log(`  ${bold('private')} ${privatePath} ${gray('(keep this; never commit it)')}`)
  ctx.log(`  ${bold('public ')} ${publicPath}`)
  ctx.log(`  ${bold('print  ')} ${cyan(pair.fingerprint)}`)
  ctx.log('')
  ctx.log(gray('Trust the public half in Settings → Signing keys, then sign a'))
  ctx.log(gray(`definition with:  flowforge sign <file> --key ${privatePath}`))
  return 0
}
