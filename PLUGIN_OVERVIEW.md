# Focused Diff

- `app.tsx`: composer banner, repository/file list, host-owned diff viewer in a thread panel.
- `server.ts`: thread metadata, completed file-change history, explicit registration tool and CLI, host routing.
- `tracking.ts`: successful file-change path extraction, including rename destinations.
- `host.ts`: typed RPC on the environment machine.
- `git.ts`: Git root resolution and read-only status/diff calls for selected repositories.
- `contracts.ts`: shared wire schemas and limits.

The plugin uses public Plugin SDK APIs only. Its Enabled Project setting gates Git reads, event tracking, tools and skills. It has no background repository scans or Git mutation commands.
Read-only tracking hooks follow thread events. UI polling is disposed on unmount, and host calls are cancelled on plugin disposal.
