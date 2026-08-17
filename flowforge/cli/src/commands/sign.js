// flowforge sign <file> --key <private.key> [--out <file>] — attach a signature
// to an exported workflow document, or check one that is already attached.
//
// Also offline. The point of signing at all is that the approval happens where
// the review happens — a signature minted by the server it is presented to
// proves nothing about who approved the definition.
//
//   flowforge export $WF > workflows/sync.json
//   flowforge sign workflows/sync.json --key ~/.flowforge-signing.key
//   git commit -am "promote sync"        # the signature travels with the diff
//
// `--check <public.pub>` is the other direction, for a reviewer holding the
// public half: verify the file in front of you without a server, a token, or
// trust in the pipeline that handed it over. Exits non-zero when it does not
// verify, so a pre-merge hook can use it.
//
// The digest is printed either way, because it is the thing worth comparing by
// eye: it identifies the graph's *meaning* rather than the file's bytes, so two
// files that differ only in layout print the same one.

const fs = require('fs')
const { bold, gray, green, red, cyan } = require('../format')
const { signDocument, verifyDocument, digestOf, fingerprint } = require('../signing')

module.exports = async function sign(args, ctx) {
  const [file] = args.positionals
  if (!file) {
    ctx.log('Usage: flowforge sign <file> --key <private.key> [--out <file>]')
    ctx.log('       flowforge sign <file> --check <public.pub>')
    return 1
  }

  let document
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    ctx.log(red(`Could not read ${file}: ${err.message}`))
    return 1
  }
  const graph = document?.graph_data || document?.graph
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    ctx.log(red(`${file} does not look like an exported workflow (no graph_data.nodes/edges).`))
    return 1
  }

  if (args.flags.check) return check(args, ctx, document, file)

  if (!args.flags.key) {
    ctx.log(red('Pass --key <private.key> to sign, or --check <public.pub> to verify.'))
    return 1
  }

  let privateKey
  try {
    privateKey = fs.readFileSync(args.flags.key, 'utf8')
  } catch (err) {
    ctx.log(red(`Could not read ${args.flags.key}: ${err.message}`))
    return 1
  }

  let block
  try {
    // The signature covers everything except itself, so re-signing an already
    // signed document replaces the block rather than signing over it.
    const { signature: _previous, ...payload } = document
    block = signDocument(payload, privateKey)
    document = { ...payload, signature: block }
  } catch (err) {
    ctx.log(red(`Could not sign with that key: ${err.message}`))
    return 1
  }

  const out = args.flags.out || file
  try {
    fs.writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`)
  } catch (err) {
    ctx.log(red(`Could not write ${out}: ${err.message}`))
    return 1
  }

  ctx.log(green(`✓ Signed ${out}`))
  ctx.log(`  ${bold('digest')} ${cyan(digestOf(document))}`)
  ctx.log(`  ${bold('key   ')} ${block.keyFingerprint}`)
  ctx.log(gray('  The signature covers what the workflow does — node config,'))
  ctx.log(gray('  wiring and declared guarantees — not the file’s layout, so a'))
  ctx.log(gray('  re-export after somebody moves a node still verifies.'))
  return 0
}

function check(args, ctx, document, file) {
  let publicKey
  try {
    publicKey = fs.readFileSync(args.flags.check, 'utf8')
  } catch (err) {
    ctx.log(red(`Could not read ${args.flags.check}: ${err.message}`))
    return 1
  }

  if (!document.signature) {
    ctx.log(red(`${file} carries no signature.`))
    return 1
  }

  const ok = verifyDocument(document, publicKey)
  const print = (() => {
    try {
      return fingerprint(publicKey)
    } catch {
      return '(unreadable key)'
    }
  })()

  if (!ok) {
    ctx.log(red(`✗ ${file} does not verify against ${print}.`))
    ctx.log(
      gray(
        document.signature.keyFingerprint === print
          ? '  It was signed by this key and has changed since — the document was modified.'
          : `  It claims to be signed by ${document.signature.keyFingerprint}.`
      )
    )
    return 1
  }

  ctx.log(green(`✓ ${file} verifies against ${print}.`))
  ctx.log(`  ${bold('digest')} ${cyan(digestOf(document))}`)
  return 0
}
