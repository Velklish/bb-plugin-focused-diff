# Focused Diff

**Keep the changes in focus.** One change tracker for the current checkout and repositories touched by this thread, right above the BB composer.

Working from a parent directory can hide changes in nested Git repositories. Focused Diff groups their **Uncommitted** and **Committed** changes in one compact **Changes** card. The card starts collapsed whenever you open a thread. Inside, repositories start expanded and can be collapsed independently. Their state is saved in this browser per thread and repository, including across reloads. Selecting a file opens the native BB **Unified** or **Split** viewer.

Checkouts that share a Git common directory appear in one repository group. If multiple checkouts have changes, each can be collapsed by its branch header. Collapsed checkouts show their file and line totals, and their disclosure state is saved per thread and checkout. One changed checkout shows its branch and files directly under the repository. Independent clones have separate groups even when they share a remote.

While the replacement has a successful snapshot, it hides the built-in Git summary in that composer, including the card around it. Parent-thread and pull-request controls remain visible and keep that card. Disabling the plugin, leaving its enabled Project, or losing the snapshot restores the built-in summary. The global **Show Git changes** setting is not changed. This does not replace the Git panel or timeline diffs.

## Install and enable

Requires BB 0.46.0 or later and Plugin SDK 0.6.37 compatibility.

```sh
bb plugin install git:https://github.com/Velklish/bb-plugin-focused-diff.git@v0.1.0
```

Open **Settings → Installed plugins → Focused Diff** and choose **Enabled Project**. The default is disabled. Each installation enables one Project. Clear the selection to stop tracking; change it to enable another Project.

BB installs plugins on the server. Focused Diff processes events, reads Git, and contributes its agent tool and skill only for the selected Project. Threads in other Projects have no banner or repository tracking. Changes to tools and skills take effect when BB next constructs the provider session; existing sessions can use the CLI. Previously stored tracking metadata is retained when a Project is disabled.

BB also registers the **Focused Diff** panel launcher globally. It may appear in other Projects; opening it there shows an inactive state without diff polling or Git reads. The current Plugin SDK does not offer a Project visibility filter for this launcher.

## Which repositories appear?

The current checkout is included without registration. Successful `fileChange` events identify additional repositories automatically, including earlier events in the current thread. Reads, failed edits, and unrelated nested repositories are excluded. No recursive repository scan is performed. Tracking belongs to one thread and is filtered by its current environment.

Before modifying a repository through shell commands, the agent registers it once with `focused_diff_track_repository`. In an existing session without that tool, use:

```sh
bb focused-diff track --path /projects/sample-app
bb focused-diff status --json
bb focused-diff track --thread thr_example --path /projects/sample-app --json
```

Register repositories you modify, not read-only dependencies or temporary test fixtures. Commands reject registration and diff access outside the enabled Project. Registration changes thread metadata, not Git files or the index.

`status --json` returns one entry per changed checkout in `repositories`, with its path and Git `commonDir`. The card uses `commonDir` to group the entries.

## What the diff means

**Uncommitted** shows the net difference from HEAD to the working tree, including staged, unstaged, and untracked files. A file modified in both the index and working tree appears once. Changes cancelled between HEAD and the working file have no net diff. Unborn repositories use the current contents of staged new files. Renames retain both paths, and Git worktrees are supported. A repository ignored by its parent still appears; its own `.gitignore` is respected.

**Committed** compares the branch HEAD with its merge base against the base branch. The current checkout follows BB's environment precedence: `mergeBaseBranch`, then `baseBranch`, then `defaultBranch`. Otherwise, each repository chooses the first available reference from `origin/HEAD`, `origin/main`, `origin/master`, `main`, and `master`. No fetch is performed. Without an available base, only Uncommitted appears; an invalid explicitly selected base shows a comparison error while keeping working changes visible.

Totals count each path once per checkout, including a path present in both sections. Line totals sum both sections. Section counts describe that section only. After a commit, changes leave Uncommitted and may appear in Committed until they are incorporated into the base branch.

This is repository-level scope, not line authorship. Your edits and another agent's edits in the same checkout are included. The card shows current working and branch differences, not a commit-history list.

Unresolved conflicts remain visible with a **Conflict** notice even when the working content matches HEAD. Staged deletions and renames with a recreated untracked source are reconciled into net file changes. These rare comparisons use a private temporary copy of the index, removed after reading. Git applies the repository's attributes and settings; index-write hooks are disabled for the temporary copy. The checkout and its real index are not written.

Opening an Uncommitted patch evaluates only the selected candidate: the plugin does not read unrelated untracked-file contents or build private indexes for unrelated recreated files. Git still inspects the working tree to discover changes and renames; errors in that shared discovery can fail the request. The full list evaluates all candidates and keeps batched Git line counts. Neither operation caches state between requests.

The banner and open diff refresh every five seconds and pause periodic reads while the browser is hidden. **Refresh** updates immediately. Closing the UI stops its polling.

The card hides when there are no changed files or comparison errors. It keeps watching for new changes and reappears automatically. Git errors and pending history remain visible; binary files and renames can still appear with zero line counts. A failed status request or repository read restores the built-in summary as a fallback.

Binary files show a notice. New text files above 512 KiB and patches above 2 MiB show size notices. Incomplete line totals are marked **partial**. A thread supports 128 registered repositories plus its current checkout, and each repository supports 2000 change entries across both sections. Git errors and exceeded limits are shown explicitly. Deleted registered paths silently disappear from the list on the next refresh. Replaced registered paths are reported as errors; the current checkout remains a separate entry.

The 2000-candidate limit applies during discovery, including when opening one Uncommitted patch, before the plugin reads candidate contents. The separate 2000-result limit applies to the complete list across Uncommitted and Committed; a path in both sections counts as two entries for this limit.

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
