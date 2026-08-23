# Approval gates: who, how many, and not the person who asked

An approval node pauses a run until a human decides. The original rule was
"until **a** workspace member responds", which is the right default and the
wrong one for the runs anybody actually puts a gate in front of.

Look at what those runs are. A refund over ten thousand. A production database
migration. A payout. A deploy on a Friday. For every one of them the interesting
requirement is not that *a* human looked — it is that **the right humans**,
**enough of them**, and **not the person who asked**.

Three declarations on the node close that gap. The user-facing surfaces are the
Approval node's config panel, the run panel, the **Waiting on you** inbox,
`flowforge approvals` / `approve` / `reject`, and the public API.

- [The three declarations](#the-three-declarations)
- [Why a single rejection settles it](#why-a-single-rejection-settles-it)
- [One person, one vote](#one-person-one-vote)
- [The gate travels with the request](#the-gate-travels-with-the-request)
- [Two writes, not one](#two-writes-not-one)
- [What the linter refuses](#what-the-linter-refuses)
- [Limits, stated](#limits-stated)

---

## The three declarations

| Config | Default | What it does |
|---|---|---|
| `quorum` | `1` | How many **distinct** people must approve. |
| `approverRole` | `any` | `owner` restricts the decision to workspace owners. |
| `separationOfDuties` | `false` | Whoever triggered the run may not approve it. |

Every default is the behaviour every approval had before these existed, so an
existing node is untouched by their arrival — and the stored row, the published
event and the API payload stay byte-for-byte what they were unless a gate
actually declares something.

**Quorum** is four-eyes: the standard control for a change the person making it
cannot undo. **Required role** exists because a control any member can wave
through is a control the organisation does not have. **Separation of duties** is
the oldest control there is, and the one a self-service automation tool most
needs — without it, the person who wants the refund is one click away from
granting it to themselves.

---

## Why a single rejection settles it

A quorum of approvals means *enough people agree this is safe to do*. One person
saying it is not means it is not.

The symmetric-looking alternative — requiring a quorum of **rejections** — sounds
principled and is wrong in a way that matters: it means a lone reviewer who spots
the problem cannot stop it. They would have to go and find two colleagues to
agree with them before the thing they think is dangerous stops happening.
Change-approval boards resolve this the same way, for the same reason.

So `verdict()` short-circuits on the first `reject`, whatever the quorum, and
reports how many approvals had been gathered before it — that number is part of
the incident record even though it changed nothing.

---

## One person, one vote

A quorum somebody can satisfy alone is not a quorum. That constraint **is** the
feature, so it is enforced by a `UNIQUE (approval_id, user_id)` index rather
than by a check-then-insert: two simultaneous clicks from the same account would
both pass a check, and only the database can settle that race.

The duplicate surfaces as a `409` with `reason: "already-responded"` carrying
the current progress, so the second click reads as "you've already voted, here's
where it stands" rather than as an error.

Deduplication also happens in `verdict()` itself, because that function is
called on a set of rows loaded before the insert that would have collided.
Belt and braces on purpose: one of them is the invariant, the other is what
makes the reported count right in the window between them.

---

## The gate travels with the request

The gate is resolved **when the request is filed** and stamped onto the row —
`quorum`, `required_role`, `excluded_user_id` — rather than read from the node's
config when somebody responds.

Two things follow, and both matter:

- **Editing the canvas mid-wait cannot change what the people looking at the
  approval were told it required.** Somebody who was asked for two approvals is
  not silently switched to four because a colleague was editing.
- **The audit trail records the gate that actually applied**, not whatever the
  node says today.

`excluded_user_id` is resolved from the run's `triggered_by`, which is why it is
a stored value rather than a flag: on a webhook or schedule run there *is* no
triggering user, so the column is null and the control is honestly inert. It
does not quietly become something else.

---

## Two writes, not one

A response used to be one `UPDATE`. It is now a **vote** and — only when the
votes settle the gate — a **verdict**.

Splitting them is what makes a quorum possible at all, and it is also what makes
the trail answer the question an incident review actually asks. The
`responded_by` column on the approval row can only hold whoever happened to be
**last**, which under four-eyes is the least interesting of the names.
`execution_approval_responses` keeps every vote, with its note and its
timestamp, for as long as the run exists.

A partial approval is logged to the activity feed too (`approval.recorded`).
If the request then times out, that entry is the only record that anybody
approved it at all.

### Status codes

A vote that does not settle the gate returns **`202`**, not `200`. A CI job or a
chat-ops bot that treats every 2xx as "approved" would otherwise act on a
half-met quorum — the precise failure four-eyes exists to prevent. `flowforge
approve` reads `progress.settled` rather than the status line for the same
reason, and prints *"recorded — 1 of 3 approvals, the run is still waiting"*.

A `403` now carries **which** rule refused: `viewer`, `role`, or
`separation-of-duties`. "You can't approve this" without saying why is the kind
of response that becomes a support ticket.

---

## What the linter refuses

An unsatisfiable gate does not fail. It **waits** — until the timeout takes the
rejected branch or fails the run. Nobody discovers a four-approval gate in a
three-person workspace until a production run is stuck behind it at 3am, and by
then the evidence is a timeout that looks like nobody was paying attention.

So the linter counts who could actually settle the gate *in the workspace it
will run in*, and refuses the ones that cannot pass:

- **quorum larger than the pool** — an error naming both numbers;
- **an owner-only gate counted against owners**, not members — the case somebody
  gets wrong right after promoting a colleague;
- **a quorum separation of duties makes unreachable** — three members, quorum
  three, and one of them starts the run leaves two.

Plus a warning for a separation-of-duties declaration that can never engage: a
workflow with no manual trigger is started by a webhook or a schedule, neither
of which carries a user to exclude. Reported rather than silently ignored,
because an author who declared it believes it is protecting them.

Two precision rules keep it honest. **Viewers are not counted** — they see the
inbox and cannot decide it, so counting them would make a quorum look
satisfiable when it is not. And the exclusion is **only deducted on a workflow
that can be manually triggered**, because a spurious error would send somebody
to fix a correct graph.

The public lint route counts in the **target** workspace, exactly as it checks
the target's guarantees — so `flowforge lint <id> file.json` catches a promotion
into a smaller team before it lands.

---

## Limits, stated

- **Separation of duties is inert on unattended runs.** A webhook delivery and a
  schedule tick have no user. The linter says so; the runtime does not pretend
  otherwise.
- **It excludes the *triggering* user, not an approver's manager or team.** There
  is no org chart here, and inventing one would be a worse control than none.
- **A workspace owner can always add themselves as a second approver.** This is
  a control against mistakes and casual self-service, not against a determined
  administrator — the tamper-evident audit log is the control for that, and it
  records every membership change.
- **A quorum does not survive a timeout.** Partial approvals are recorded but the
  gate did not pass, so the node's `onTimeout` policy applies exactly as it would
  have with none.
