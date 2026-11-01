# Focused Diff

- `app.tsx`: compact Changes card, independent repository/section disclosures, host-owned diff viewer in a thread panel.
- `native-tracker.ts`: scoped replacement of the native composer Git summary; the content-script stylesheet is removed on disposal.
- `server.ts`: thread metadata, completed file-change history, explicit registration tool and CLI, host routing.
- `tracking.ts`: successful file-change path extraction, including rename destinations.
- `host.ts`: typed RPC on the environment machine.
- `git.ts`: current checkout resolution, net working-tree diffs, merge-base branch comparisons, and read-only status/diff calls for selected repositories.
- `contracts.ts`: shared wire schemas and limits.

The plugin uses public Plugin SDK APIs only. Its Enabled Project setting gates Git reads, event tracking, tools and skills. It has no background repository scans or Git mutation commands.
Read-only tracking hooks follow thread events. UI polling is disposed on unmount, and host calls are cancelled on plugin disposal.
Native Git controls are hidden only inside a composer with a successful replacement snapshot. The summary card is removed with them when it has no other context. Other composer context and other Projects retain their native controls. No global app setting is changed.
