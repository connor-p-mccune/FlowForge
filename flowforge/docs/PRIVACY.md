# Privacy: erasure, over a system built to make deletion hard

Somebody exercises their right to erasure. FlowForge holds their order payload
in a hundred `executions.trigger_data` rows and a thousand
`execution_steps.output_json` rows, and it holds a **hash-chained,
schema-enforced append-only audit log** that exists precisely so nobody can
quietly remove things from it.

Those two facts are in direct conflict, and the conflict is the design.

The surfaces are `flowforge subject <identifier> [--erase --yes]`,
`POST /api/v1/subjects/access` and `POST /api/v1/subjects/erasure`.

---

## First: which runs are even about this person?

FlowForge records executions, not customers. Nothing in a run says whose it is,
so before anything can be erased there has to be a way to find it.

A workflow declares it. `workflows.subject_path` names the field of the trigger
payload that identifies the data subject — `customer.email`, `user.id` — and at
run start the engine resolves that path and stamps the execution row.

**What it stamps is not the identifier.** It is:

```
subject_id = HMAC-SHA256(pepper, workspace_id ‖ normalise(identifier))
```

The reason shows up the moment you try to *honour* the request rather than just
service it. After an erasure you must keep proof it happened — who asked, when,
what scope. If the index were keyed on `alice@example.com`, the one artefact you
are contractually obliged to retain would be a copy of the identifier you were
asked to delete.

Three details, each load-bearing:

- **Keyed, not plain.** A plain SHA-256 of an email is not a pseudonym, it is a
  dictionary attack: the space of email addresses is small enough to enumerate.
  The pepper is what makes the mapping irreversible without it.
- **Scoped per workspace.** A shared key would let one workspace confirm that an
  address it holds also appears in somebody else's — a cross-tenant leak dressed
  as an optimisation.
- **Normalised.** `Alice@Example.com ` and `alice@example.com` are the same
  person. A request that missed the runs recorded under the other spelling is a
  request nobody can rely on.

**The limit, stated rather than glossed:** a pseudonymous identifier is still
personal data under GDPR. It is linkable to a person by anyone holding the
pepper — which is exactly what makes it usable. What it buys is that the linkage
requires a secret the database does not contain, which is the same bargain
[the secret vault](./ARCHITECTURE.md) makes and the same one it is honest about.

---

## The conflict

[The audit log](./ARCHITECTURE.md#the-tamper-evident-audit-log) is a hash chain:
`hash(n) = SHA-256(canonical(entry n) ‖ hash(n−1))`, with a contiguous per-
workspace `seq`, and `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort the
statement. That is the whole basis of its value — a log is evidence only if
altering it is detectable.

Three obvious answers to the erasure request, each wrong:

**1. Delete the rows.** The trigger refuses. And if it did not: removing an entry
breaks the chain at the join *and* leaves a gap in `seq`, so honouring one
person's request would destroy the evidentiary value of every unrelated entry in
the workspace.

**2. Rewrite the chain.** Recompute the hashes after the gap and it all verifies
again — which demonstrates that the chain *can* be rewritten by anyone with
write access, which is precisely the property it exists to deny. A chain that
was rewritten once proves nothing about any entry in it.

**3. Never log anything that could contain personal data.** Then there is no
audit trail, and the request cannot be proved honoured either.

---

## The resolution: erase the data, append to the log

Erasure never touches the audit log. It empties the **run data** — the trigger
payload and every recorded step input and output — and then **appends** an
entry. The chain grows; nothing in it changes; `verifyChain` still passes. There
is a test that asserts exactly that, through the same `audit/verify` route an
auditor would use.

What the appended entry carries is a **commitment**: a SHA-256 per run over what
was removed. Not the content.

That distinction is the crux. A hash of data you have destroyed is not personal
data — it is a receipt. It lets the record confirm a specific claim later (a
subject disputing what was held, an auditor checking the scope matched the
request) if somebody independently produces the data, while the log itself
retains nothing readable and nothing enumerable.

```console
$ flowforge subject alice@example.com --erase --yes --reason "Ticket 4821"
Erased
  2 run(s) emptied at 2026-08-22 12:00:00.
  certificate 5f8c1e2a-0b3d-4c5e-8a9f-1b2c3d4e5f60

  A commitment to what was removed is recorded per run — a SHA-256 receipt, not a
  copy — and appended to the workspace audit chain, which still verifies.

RUN   COMMITMENT
ex-1  a3f1c9e20b4d5768…
ex-2  7b2e4d81f0a6c395…

  Backups are not reached by this. A snapshot taken before now still holds the payload.
```

### The rows survive, emptied

Deleting the execution rows would take the proof of the erasure with the thing
erased, and *"we deleted it, trust us"* is the answer this whole design exists
to avoid giving. So the row stays, `erased_at` is stamped, and the payload
columns hold a tombstone:

```json
{ "__erased": { "at": "2026-08-22T12:00:00.000Z", "certificate": "5f8c1e2a-…" } }
```

An object rather than `NULL`, because every reader of those columns — the run
view, [preview](./PREVIEW.md), [drift profiling](./DRIFT.md) — should be able to
tell *erased on request* from *never recorded*, and a null looks like a bug to
whichever of them encounters it first.

One transaction, so there is no half-done state nobody could act on, and
idempotent, so a repeated request erases nothing and still succeeds.

---

## Access is the same machinery, run backwards

`POST /api/v1/subjects/access` returns every run recorded against the
identifier, with the trigger payload and each step's input and output. The data
rides along because that is what the right of access *is* — a list of run ids
would be a receipt, not a disclosure.

Already-erased runs are listed with their data absent and their erasure dated,
because *"we held something and destroyed it on this date"* is itself part of
the answer.

Both endpoints take the identifier in a **POST body**, never a URL: it is
personal data, and a URL ends up in query logs, proxy logs and browser history.
Both require the `manage` scope. Access is not an escalation over `read` — a
token that can list executions can already read their steps — but a bulk
cross-workflow disclosure about a named person is a governed act and erasure is
destructive and audited, so scoping them the same way means the audit entry
always names somebody who was trusted with the workspace.

---

## What it does not claim

- **Backups are out of scope, and say so.** This erases rows in the live
  database. A snapshot taken yesterday still holds the payload, and no `UPDATE`
  reaches it. The honest answer is a retention policy on backups, not a claim
  this feature cannot support — and the CLI prints that sentence rather than
  letting somebody infer otherwise.
- **The stronger design is named.** Encrypting each subject's data under a
  per-subject key and destroying the key would reach backups too, and would make
  erasure O(1) regardless of how many runs there are. It is also a much larger
  change: every one of the twenty-one places that read a step payload would have
  to read through a decryption, including the drift profiler and the replay
  engine. It is the right next step and it is not this one.
- **A workflow with no `subject_path` is not indexed.** Its runs cannot be found
  by subject, and this reports nothing about them rather than guessing which
  field might be an email.
- **It does not erase what the graph sent elsewhere.** A run that POSTed the
  payload to a partner API put it somewhere this has no reach into. What the
  [effect report](./EFFECTS.md) is for is knowing *which* partners, which is the
  first question a real erasure request raises.
