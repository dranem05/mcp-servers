# experimental/

Not published. `package.json` declares `files: ["dist", "README.md"]`, so nothing
in this directory reaches npm consumers. This is a staging area for capability
that may graduate into the MCP proper once its shape settles.

## `todo-local`

Reads **assignment and attribution** out of the Microsoft To Do macOS app's local
store — the three things Microsoft Graph does not expose at all:

- who a task is assigned to (`assignments` table)
- who created it (`tasks.created_by`)
- who completed it (`tasks.completed_by`)

Graph's `todoTask` resource has none of these in v1.0 *or* beta. Verified
2026-09-09 by asking Graph directly: `$select=assignments` and
`$select=assignedTo` both return `Could not find a property named ... on type
'microsoft.graph.todoTask'` — the metadata itself rejects the field. Assigning a
task in the To Do app moves its `lastModifiedDateTime` while leaving every
readable field byte-identical, so the data exists server-side and the API simply
will not surface it.

### Why this could fold into the MCP later

The local `tasks.online_id` is **byte-identical to the Graph task id**, so
enrichment needs no mapping layer: fetch via Graph, attach assignee/completer
from the local store keyed on the id you already have.

If it does graduate, it should be **capability-detected, not core** — register
the extra tools only when the local store is present, so the package stays a
clean, platform-neutral Graph client on Windows, Linux, and Macs without the
desktop app installed.

### Deploying it

This file is the canonical source. Do **not** point a caller at this path — it
lives in a git working tree, so a branch checkout can move or remove it out from
under a running job. Deploy a runtime copy instead, the same way the rest of the
OpenBrain runtime works (repo holds the tracked copy, `~/.config/openbrain/`
holds the live one):

```
install -m 755 packages/microsoft-todo-mcp/experimental/todo-local \
        ~/.config/openbrain/lib/todo-local
```

Re-run that after any edit here — the runtime copy does not update itself, and a
stale copy is the obvious failure mode of this arrangement.

### Usage

```
todo-local assigned  [--list NAME] [--json]     # open tasks with an assignee, by person
todo-local completed --since YYYY-MM-DD         # who closed what
todo-local tags      [--list NAME] [--json]     # open tasks grouped by #hashtag
todo-local people    [--json]                   # id -> name
todo-local schema-check                         # verify the store before trusting output
```

### Constraints worth keeping

- **Read-only by construction.** The store is snapshotted to a temp dir and
  opened `mode=ro`. The app owns that file and reconciles it against the server;
  writing to it means fighting a sync engine, and the failure mode is silent
  corruption of real task data. Use Graph (or a `#tag` in the title) to write.
- **Undocumented schema.** `schema-check` runs before every command and exits 3
  naming the missing column rather than returning plausible-but-wrong output.
  To Do ships bugfix releases regularly (2.177 as of 2026-07-06), so drift is
  unlikely but not impossible.
- **`completed_datetime` is a date, not a timestamp** — stamped at local
  midnight. Use `last_modified` for when the tap actually happened. The same trap
  exists in Graph: requesting a timezone preference returns the *previous* day.

### Status

Incubating. Nothing depends on it yet. The command surface above is a guess at
what a consumer will want; let real usage settle it before freezing any of this
into a published API.
