# Three-way merge

Git's merge, for a canvas.

```
Merging workflows/sync.json into the live workflow, against version 7.
  +1 added   ~2 changed   -0 removed   4 unchanged

1 conflict — nothing was written:
  ✗ Charge card · config.url: live "https://pay.acme.com/v2"
                              vs document "https://pay.acme.com/v1"

Resolve it on the canvas, or re-run with --ours (keep the live value)
or --theirs (take the file's).
```

---

## The gap this closes

FlowForge already had most of the GitOps loop:

| Step | Command |
|---|---|
| Definitions live in git | `flowforge export` |
| Promote between environments | `flowforge import` |
| Catch divergence | `flowforge diff` |
| **Resolve divergence** | — |

Detection is where it stopped, and detection alone leaves two bad options:
import the file and lose whatever was edited on the canvas, or re-export and
lose the change that went through code review. Both discard work somebody did
on purpose.

A two-way comparison **cannot** do better, because it cannot tell *added on one
side* from *deleted on the other* — those look identical when you only have two
graphs. Distinguishing them requires a common ancestor, which is exactly why git
merges from a merge-base.

```
             base          the last point the two provably agreed
            /    \
        ours      theirs   the live canvas   /   the document in git
            \    /
            merged
```

---

## Merging is per field

This is the entire reason to implement a real three-way merge rather than pick a
side.

One person changes an HTTP node's **URL** on the canvas. Another changes its
**retry count** in git. Those are unrelated edits to the same node, and they
merge cleanly:

| | base | ours (live) | theirs (git) | merged |
|---|---|---|---|---|
| `config.url` | `/v1` | `/v2` | `/v1` | **`/v2`** |
| `config.retries` | `3` | `3` | `5` | **`5`** |

A node-granular merge would call that a conflict and be useless for the exact
situation it exists for.

### Three rules follow from what a graph is

**Position never conflicts.** Dragging a node is not a semantic change. The
drift detector already ignores position for this reason, and a merge that
stopped to ask about coordinates would be unusable. Ours wins, silently.

**Identical edits are agreement.** If both sides changed a field to the *same*
value, there is nothing for a human to decide. Git treats it the same way.

**Edges are a set, not a record.** An edge *is* its `(source, target,
sourceHandle)` triple, so a re-created but equivalent connection is the same
edge — the same key the drift detector uses. Edges have no fields, so they only
appear or disappear, and additions and removals merge as a set.

---

## Conflicts

| Kind | Means |
|---|---|
| `field` | both sides changed the same config field to different values |
| `modify-delete` | the document deleted a node the live workflow edited |
| `delete-modify` | the live workflow deleted a node the document edited |

The two delete cases are conflicts on purpose. Deleting something that someone
else was actively working on is precisely the decision a machine should not make
alone.

### A conflicted merge produces no graph

Git can leave conflict markers in a file because **a file with markers is still
a file** — it opens, an editor renders it, a human fixes it.

A graph with markers is not a graph. There is nowhere to put them that the
engine, the linter and the canvas would all tolerate, and writing a half-merged
definition into a workflow that may be deployed is not an acceptable failure
mode. So a conflicted merge reports and writes nothing at all — not even the
parts that merged cleanly.

Two ways forward:

```bash
flowforge merge <id> file.json --ours      # keep the live value on conflicts
flowforge merge <id> file.json --theirs    # take the document's
```

Both are the equivalent of git's `-X ours` / `-X theirs`, and both are
deliberate choices rather than defaults — silently picking a side is the
behaviour this feature exists to replace.

---

## The base

By default: the workflow's **latest version snapshot**.

A snapshot is taken at every deploy, and a deploy is where the exported document
came from — so it is the last point the file and the live canvas provably
agreed. `--base <version>` names another for the case where the document was
exported from an older release.

A workflow with **no snapshots** merges against an empty base. That reads every
node as *added* by whichever side has it, which is the safest available
interpretation: with no ancestry, the merge can never conclude that something
was deleted, and deletion is the only outcome that loses work silently.

---

## Graph integrity

A merge of two individually valid graphs can produce one that will not run.

**Dangling connections are dropped, and reported.** If the document deleted a
node and the canvas added an edge into it, that edge survives the set merge and
points at nothing. It is debris rather than a conflict — but silently deleting a
connection somebody drew is exactly what a merge must not do, so it appears in
`droppedEdges`.

**The result is linted, not the inputs.** A reference to a node the other side
deleted lints as an error, and after applying the merge is the worst possible
time to find that out. The response carries the linter's verdict on the *merged*
graph, and `flowforge merge --yes` exits non-zero when the result has errors.

---

## Applying

```bash
flowforge merge <workflow-id> <file>          # preview — changes nothing
flowforge merge <workflow-id> <file> --yes    # write it
```

Applying updates **the canvas, not the deployment**. A merged definition becomes
the live graph exactly as an edit would; going live stays a deliberate deploy,
which also means a canary can carry the merge if the change is risky.

Every applied merge is in the [audit log](./ARCHITECTURE.md#the-tamper-evident-audit-log)
with its base version, strategy and summary — a definition changed from outside
the app by a token is precisely what an audit trail is for.

### Exit codes

| Code | Means |
|---|---|
| `0` | merged cleanly (previewed, or applied and lints clean) |
| `1` | the command failed, or the merged graph has lint errors |
| `2` | **conflicts** — the merge needs a person |

`2` is distinct from `1` on purpose. A conflict is not a failure; it is a merge
that needs review. A pipeline that treats "needs review" identically to "broken"
cannot tell a colleague's edit from an outage — the same reasoning behind
`flowforge release`'s exit `2`.

---

## In CI

```yaml
- name: Reconcile the workflow with git
  run: |
    npx --prefix cli flowforge diff  "$WF" workflows/sync.json && exit 0
    npx --prefix cli flowforge merge "$WF" workflows/sync.json --yes
  env:
    FLOWFORGE_URL: ${{ vars.FLOWFORGE_URL }}
    FLOWFORGE_TOKEN: ${{ secrets.FLOWFORGE_TOKEN }}   # needs the `manage` scope
```

A clean run reconciles automatically; a conflicted one exits `2` and the job
stops with the conflicting fields named, for a person to resolve on the canvas.

---

## Limits, stated plainly

**There is no merge history.** Unlike git, FlowForge does not record that a
merge happened in the graph itself — a merged workflow is just a workflow whose
canvas changed, and the record lives in the audit log rather than in the
definition. A second merge therefore uses the latest snapshot as its base, not
the previous merge's result, so **deploy after merging** if more merges are
coming.

**Config values are compared whole.** A conflict on a field is a conflict on the
whole value: two people editing different keys inside the same JSON headers blob
conflict, because the merge sees one string. Splitting a node's config into
fields is the granularity the node contract provides; going deeper would mean
guessing at the structure of a value the runner defines.

**Merging does not resolve policy.** A cleanly merged graph can still be refused
at deploy by a [workspace policy](./POLICIES.md). That separation is deliberate:
merging asks "what do these two versions add up to?", the policy gate asks "is
the result allowed here?", and answering the second during the first would make
a governance rule silently rewrite somebody's merge.
