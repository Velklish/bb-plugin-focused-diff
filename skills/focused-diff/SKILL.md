---
name: focused-diff
description: Register repositories modified by the current BB thread so their current changes appear above the composer in the enabled Project.
---

Before modifying or committing files in a repository through shell commands, call `focused_diff_track_repository` once with its absolute path. Successful fileChange events are also tracked automatically.

If the tool is unavailable in an already-running provider session, use `bb focused-diff track --path /absolute/repository/path`. The command defaults to the current thread. Use `--thread <id>` only when another thread is explicitly intended.

Register only repositories you modify. Do not register repositories you merely read or temporary test fixtures. Registration changes thread metadata, not repository files or Git state.

Use `bb focused-diff status --json` to inspect current changes. It includes the current checkout without registration and additional repositories registered by this thread. `uncommitted` entries show net HEAD-to-working-tree changes, including untracked files. `committed` entries show branch changes from the merge base against `baseBranch`. Each repository reports its own branch and comparison error, if any. This view does not determine line authorship.

The Changes card groups linked worktrees under their shared Git repository. When several checkouts have changes, each branch header collapses its own diff sections and shows the checkout totals. The card replaces the native Git summary in that composer while a successful snapshot is available, and restores it on failure or plugin disable without changing the global Show Git changes setting.

The plugin must be enabled for the thread's Project in Settings → Installed plugins → Focused Diff → Enabled Project. Other Projects are excluded from tracking and Git reads.
