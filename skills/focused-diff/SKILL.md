---
name: focused-diff
description: Register repositories modified by the current BB thread so their current changes appear above the composer in the enabled Project.
---

Before modifying or committing files in a repository through shell commands, call `focused_diff_track_repository` once with its absolute path. Successful fileChange events are also tracked automatically.

If the tool is unavailable in an already-running provider session, use `bb focused-diff track --path /absolute/repository/path`. The command defaults to the current thread. Use `--thread <id>` only when another thread is explicitly intended.

Register only repositories you modify. Do not register repositories you merely read or temporary test fixtures. Registration changes thread metadata, not repository files or Git state.

Use `bb focused-diff status --json` to inspect current changes. Staged, unstaged, and untracked changes from the thread's registered repositories are included. Commits disappear from this current-diff view; it does not determine line authorship.

The plugin must be enabled for the thread's Project in Settings → Installed plugins → Focused Diff → Enabled Project. Other Projects are excluded from tracking and Git reads.
