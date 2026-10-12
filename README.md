# Focused Diff

**Keep the changes in focus.** Current diffs from repositories touched by this thread, right above the BB composer.

Working from a parent directory can hide changes in nested Git repositories. Focused Diff follows the repositories your thread actually modifies, gives you a compact file and line summary, and opens the native BB **Unified** or **Split** viewer when you select a file.

## Install and enable

Requires BB 0.46.0 or later and Plugin SDK 0.6.37 compatibility.

```sh
bb plugin install git:https://github.com/Velklish/bb-plugin-focused-diff.git@v0.1.0
```

Open **Settings → Installed plugins → Focused Diff** and choose **Enabled Project**. The default is disabled. Each installation enables one Project. Clear the selection to stop tracking; change it to enable another Project.

BB installs plugins on the server. Focused Diff processes events, reads Git, and contributes its agent tool and skill only for the selected Project. Threads in other Projects have no banner or repository tracking. Changes to tools and skills take effect when BB next constructs the provider session; existing sessions can use the CLI. Previously stored tracking metadata is retained when a Project is disabled.

BB also registers the **Focused Diff** panel launcher globally. It may appear in other Projects; opening it there shows an inactive state without diff polling or Git reads. The current Plugin SDK does not offer a Project visibility filter for this launcher.

## Which repositories appear?

Successful `fileChange` events identify the repositories automatically, including earlier events in the current thread. Reads, failed edits, and unrelated repositories are excluded. No recursive repository scan is performed. Tracking belongs to one thread and is filtered by its current environment.

Before modifying a repository through shell commands, the agent registers it once with `focused_diff_track_repository`. In an existing session without that tool, use:

```sh
bb focused-diff track --path /projects/sample-app
bb focused-diff status --json
bb focused-diff track --thread thr_example --path /projects/sample-app --json
```

Register repositories you modify, not read-only dependencies or temporary test fixtures. Commands reject registration and diff access outside the enabled Project. Registration changes thread metadata, not Git files or the index.

## What the diff means

The summary includes current **staged**, **unstaged**, and **untracked** changes in the selected repositories. A file in both staged and unstaged layers is counted once; line totals include both layers. Renames retain both paths, and Git worktrees are supported. A repository ignored by its parent still appears; its own `.gitignore` is respected.

This is repository-level scope, not line authorship. Your edits and another agent's edits in the same checkout are included. Committed changes disappear from the current diff; commit history is not tracked.

The banner and open diff refresh every five seconds and pause periodic reads while the browser is hidden. **Refresh** updates immediately. Closing the UI stops its polling.

The banner hides when there are no changed files. It keeps watching for new changes and reappears automatically. Git errors and pending history remain visible; binary files and renames can still appear with zero line counts.

Binary files show a notice. New text files above 512 KiB and patches above 2 MiB show size notices. Incomplete line totals are marked **partial**. A thread supports 128 registered repositories and each repository supports 2000 change entries. Git errors and exceeded limits are shown explicitly. Missing or replaced repository paths are rejected instead of falling back to the parent repository.

## Develop

With BB and Node.js installed:

```sh
npm ci
npm test
npm run typecheck
npm run build
bb plugin install path:/absolute/path/to/bb-plugin-focused-diff
```

Release commits include the generated `dist/` artifacts. Build with the supported BB/SDK versions before tagging a release.
