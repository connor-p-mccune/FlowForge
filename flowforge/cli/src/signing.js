// Ed25519 signing for exported workflow documents, client side.
//
// This is a **second implementation of one contract**, and it is deliberate for
// the same reason the CLI has no dependencies at all: the package has to work
// standing on its own, and reaching across into the server's source would make
// `npm link cli` depend on a repository layout. The other place the codebase
// makes this trade — node-cron fires a schedule while `cronExpression.js`
// previews it — carries tests that pin the two together, and so does this one
// (`test/signing.test.js` verifies a document signed here against the server's
// verifier and asserts both produce the same digest).
//
// What the signature covers is the whole design, and it lives in
// `server/src/services/artifactSigning.js`. In one sentence: the **semantics of
// the graph**, canonicalised with the rules the semantic diff uses — positions
// excluded, nodes sorted by id with config keys sorted, edges keyed by
// (source, target, sourceHandle) — so a re-export after somebody moved a node
// still verifies, while any change to what the workflow *does* breaks it.

const crypto = require('crypto')

const ALGORITHM = 'ed25519'
const DIGEST = 'sha256'

function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  const hash = crypto.createHash(DIGEST).update(der).digest('hex')
  return hash.match(/.{1,8}/g).slice(0, 8).join(':')
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])])
    )
  }
  return value
}

const canonicalNode = (node) => ({
  id: String(node?.id ?? ''),
  type: String(node?.type ?? ''),
  label: node?.data?.label ?? null,
  config: sortKeys(node?.data?.config ?? {}),
})

const canonicalEdge = (edge) => ({
  source: String(edge?.source ?? ''),
  target: String(edge?.target ?? ''),
  handle: edge?.sourceHandle ?? null,
})

function canonicalPayload(document) {
  const graph = document?.graph_data || document?.graph || { nodes: [], edges: [] }
  const nodes = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .map(canonicalNode)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const edges = (Array.isArray(graph.edges) ? graph.edges : [])
    .map(canonicalEdge)
    .sort((a, b) => {
      const ka = `${a.source} ${a.target} ${a.handle ?? ''}`
      const kb = `${b.source} ${b.target} ${b.handle ?? ''}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
  const guarantees = (Array.isArray(document?.guarantees) ? document.guarantees : [])
    .map((g) => [String(g?.kind ?? ''), String(g?.node ?? ''), String(g?.other ?? '')])
    .sort((a, b) => (a.join() < b.join() ? -1 : 1))

  return JSON.stringify([
    'flowforge.workflow.v1',
    String(document?.name ?? ''),
    nodes,
    edges,
    guarantees,
  ])
}

const digestOf = (document) =>
  crypto.createHash(DIGEST).update(canonicalPayload(document), 'utf8').digest('hex')

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync(ALGORITHM)
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return {
    publicKey: publicPem,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    fingerprint: fingerprint(publicPem),
  }
}

function signDocument(document, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem)
  const signature = crypto.sign(null, Buffer.from(canonicalPayload(document), 'utf8'), key)
  const publicPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString()
  return {
    algorithm: ALGORITHM,
    digest: DIGEST,
    keyFingerprint: fingerprint(publicPem),
    signature: signature.toString('base64'),
  }
}

// Local verification, so a reviewer can check a file before it is anywhere near
// a server. Returns a boolean rather than throwing: the question is "is this
// trustworthy", and a garbled signature answers it with no.
function verifyDocument(document, publicKeyPem) {
  const block = document?.signature
  if (!block || block.algorithm !== ALGORITHM || typeof block.signature !== 'string') return false
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalPayload(document), 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(block.signature, 'base64')
    )
  } catch {
    return false
  }
}

module.exports = {
  ALGORITHM,
  DIGEST,
  fingerprint,
  canonicalPayload,
  digestOf,
  generateKeyPair,
  signDocument,
  verifyDocument,
}
