# Signed workflow artifacts

Proving that the definition which landed is the definition that was reviewed.

```console
$ flowforge sign workflows/sync.json --key ~/.flowforge-signing.key
✓ Signed workflows/sync.json
  digest d946f84c66a58302c4ae36ea1a57113f5d6a0e159873d93a05db33eb551da20a
  key    ded9fc50:64e8f727:…

$ flowforge import $PROD_WS workflows/sync.json
Imported Order sync as a draft.
✓ signed by release key (ded9fc50:64e8f727:…)
digest: d946f84c66a58302c4ae36ea1a57113f5d6a0e159873d93a05db33eb551da20a
```

---

## The gap this closes

The [workflows-as-code](./API.md) loop is `export → git → review → CI → import`,
and it already closes several gaps:

| | |
|---|---|
| [Drift detection](./MERGE.md) | git and production diverged |
| [Three-way merge](./MERGE.md) | reconcile them without throwing work away |
| `lint` / `verify` / [`preview`](./PREVIEW.md) | vet what the document *says* and *does* |

None of them answers a different question:

> is the graph that arrived the graph that was reviewed?

Between the approval and the import, the document passes through a repository, a
CI runner, an artifact store, and an HTTP call. A `manage` token can import **any
document at all**, so a leaked token — or a commit pushed to the release branch
after review — lands a definition nobody looked at.

Import producing a *draft* is a real mitigation and the reason this is not an
emergency. But the deploy after it is usually automated too.

---

## The mechanism

A document may carry a detached **Ed25519** signature, and a workspace keeps a
list of the public keys it trusts.

Ed25519 because Node's own `crypto` implements it: no dependency, small keys, and
no curve or hash to choose badly. The same reasoning behind the hand-rolled
[metrics registry](./ARCHITECTURE.md#observability) and
[cron engine](./ARCHITECTURE.md#schedule-preview).

```json
{
  "name": "Order sync",
  "graph_data": { "nodes": [ … ], "edges": [ … ] },
  "guarantees": [ … ],
  "signature": {
    "algorithm": "ed25519",
    "digest": "sha256",
    "keyFingerprint": "ded9fc50:64e8f727:…",
    "signature": "kK1v…"
  }
}
```

The block rides *on* the document rather than beside it, so a single file is the
whole artefact — which is what makes it survive a git diff, a review comment, and
a CI cache. The signature covers everything except itself.

---

## What the signature covers, and why that is the hard part

**Not the bytes.** A signature over the serialised document would break whenever
anything reserialised it — a different key order, a re-export, a formatter — and
a signature that breaks for cosmetic reasons is a signature people learn to skip.

It covers the **semantics of the graph**, canonicalised with exactly the rules
[the semantic diff](./MERGE.md) already uses to decide what "changed" means:

| Covered | Ignored |
|---|---|
| the workflow's **name** — it is what the import lands under | node **positions** — dragging a node is not a change to what a workflow does |
| every node's **id, type, label** | **edge ids** — React Flow mints a new one for a redrawn connection |
| every node's **config**, keys sorted | the document's **description**, `exportedAt`, and any other envelope field |
| **edges** keyed by `(source, target, sourceHandle)` and sorted | a guarantee's **note** — documentation for a human |
| the declared **[guarantees](./GUARANTEES.md)** (kind, node, other) | |

The consequence is worth stating rather than discovering:

> A signature proves what the workflow **means**, not what the file **looks
> like**.

Two documents differing only in layout share a signature — which is the property
that makes this usable in a loop where the canvas rewrites positions constantly.
And every change to behaviour breaks it: a URL, a node type, a label, a rewired
handle, a dropped guarantee.

The `digest` printed by `sign` and returned on import is the SHA-256 of that
canonical payload. It is the artefact's identity, comparable by eye, and stable
across everything in the right-hand column above.

---

## Verification has three negative answers

They call for different responses, so they are kept apart:

| Verdict | Means | Response |
|---|---|---|
| `unsigned` | no claim was made | a workspace policy question |
| `untrusted` | a well-formed signature by a key this workspace does not hold | refused — but this is what a **rotated or revoked key** looks like, not tampering |
| `invalid` | the payload does not match a signature made by a key we *do* trust | refused — this is tampering |

### The admission rule

```
trusted     always allowed
unsigned    allowed unless the workspace requires signatures
untrusted   refused, always
invalid     refused, always
```

**Enforcement decides only what an *unsigned* document means.** It does not
decide what a *broken* one means: there is no configuration under which the right
response to evidence of tampering is to shrug and import it. Conflating the two
is the mistake that makes signing decorative, and the UI says so in as many
words.

Turning enforcement on with no trusted keys is refused, because it would lock the
workspace out of its own promotions.

---

## The trust store

`workspace_signing_keys`, managed through Settings → Secrets → Signing keys.

- **Owner-only**, matching [secrets](./ARCHITECTURE.md#security-architecture) and
  status-page tokens. A list any member could append to is not a trust store, it
  is a formality — the same argument [policies](./POLICIES.md) make about a
  control anybody can switch off. Reads are owner-only too: the list of keys that
  can put code into production is exactly what a member session would like to
  enumerate.
- **Keys are parsed before they are stored.** A paste-o is a `400`, not a key
  that silently never matches anything — the same reasoning behind type-checking
  a policy rule when it is saved rather than when it first fails to fire. Only
  Ed25519 is accepted.
- **Revoked, never deleted.** A revoked key keeps its row with `revoked_at` set,
  exactly as [API tokens](./API.md#authentication) do, because the question an
  incident review asks is *what did this key sign while it was trusted* — and a
  deleted row answers it with silence. Re-trusting a revoked key reinstates the
  one row rather than adding a second, so each key has one history.
- **Revocation takes effect immediately**: verification only ever matches active
  keys, so a key revoked because it leaked stops being accepted on the next
  import.

Every change is in the [tamper-evident audit log](./ARCHITECTURE.md#the-tamper-evident-audit-log)
(`signing_key.added`, `signing_key.revoked`,
`signing_key.enforcement_changed`) — recording the **fingerprint**, never the
key. And every import records its verdict, the signing key's fingerprint, and
the digest of the graph that landed, *including unsigned imports*: "which graph
is this" is useful whether or not anybody vouched for it.

---

## Signing happens where the review happens

`flowforge keygen` and `flowforge sign` talk to **no server**, and that is the
design rather than a limitation:

- a signing key that has been near a server is a key somebody has to reason
  about;
- an approval minted by the server it is later presented to proves nothing about
  who approved the definition.

```bash
flowforge keygen --out ~/.flowforge-signing   # offline; 0600 on the private half
flowforge export $WF > workflows/sync.json
flowforge sign workflows/sync.json --key ~/.flowforge-signing.key
```

`flowforge sign <file> --check <public.pub>` is the reviewer's half: verify the
file in front of you with no server, no token, and no trust in whatever handed it
over. It exits non-zero when it does not verify, so a pre-merge hook can use it,
and it distinguishes *signed by this key and changed since* from *signed by
somebody else* — different conversations.

`keygen` refuses to overwrite an existing key pair. Silently replacing a signing
key is how a release stops verifying with no commit behind it.

### Two implementations, one contract

The CLI has no dependencies and must work standing alone, so `cli/src/signing.js`
is a second implementation of the canonicalisation rather than an import of the
server's. That is the same trade node-cron and
[`cronExpression.js`](./ARCHITECTURE.md#schedule-preview) make for schedules, and
it carries the same obligation: the CLI's test suite requires **both** modules
and asserts they produce identical payloads and digests over a spread of
documents, and that each one's signatures verify under the other's verifier. A
divergence here would not fail loudly — it would produce a signature that
verifies nowhere, found by whoever is mid-promotion at 2am.

---

## What it does not prove

That the holder of a trusted key intended *this* import, at *this* moment, into
*this* workspace. A signature is **transferable**: anyone who obtains a signed
document can present it, and a stale-but-signed definition is still signed.

This is the same limit [the audit log](./ARCHITECTURE.md#the-tamper-evident-audit-log)
states about its hash chain — internal consistency is not notarisation — and the
mitigations are the same shape rather than a promise that the gap is not there:

- the fingerprint of the signing key is recorded on every import, so *who
  approved this* has an answer;
- revoking a key stops it being accepted from that moment;
- the import lands a draft, so a deploy remains a separate act;
- and `flowforge diff` still answers whether the definition in git is the one
  running, which is the orthogonal question.

Renaming a document with `--name` on import invalidates its signature, because
the name is part of what was approved. The CLI says so before the request rather
than letting a `403` be the explanation.
