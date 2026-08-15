# dsh-delete-session

English | [中文](README.md)

Full session management for the DeepSeek Harness web UI: delete sessions (with a trash to restore or purge), restore archived sessions, view recent-activity stats, continue or pause sessions, and reveal log folders — from a Settings section and the conversation header. No harness changes.

<sub><span style="opacity:.6">Built independently with dsh + Deepseek-V4-Flash0731</span></sub>

## Features

- A dedicated **Session Manager** section in Settings (a settings section, sibling to Notifications)
- Lists all sessions (title / working directory); **archived sessions** are grouped in a collapsible area at the bottom with a **one-click Restore** back to the list
- **Trash**: deleted sessions move to the trash (keeps the most recent 10, the oldest is purged automatically), with **Restore** and **Delete permanently** actions
- **Stats**: expand any session to see recent activity (turns / user messages / assistant messages / tool calls / activity window)
- **Continue session**: open a session and close the panel; **Pause**: stop a running session's current turn
- **Folder**: reveal the session's log directory in the system file manager
- **Delete this session**: a red button in the conversation header (left of Session log) to delete the current session
- **Session Manager / Trash** header buttons: a self-drawn right drawer (pin to keep open, outside-click to close)
- Delete restriction: only sessions **currently thinking** are protected; an open-but-idle session can be deleted
- Subagent functionality is unaffected: their sessions are managed by DSH delegation, and this plugin does not offer a delete entry for them (end/clean them up within their parent session)
- UI language follows the page language (Chinese / English)

## Install

### From GitHub

```sh
dsh plugin --profile web add 'github:dream12347/dsh-delete-session#v0.1.3'
```

### From a local directory

```sh
dsh plugin --profile web add /absolute/path/to/dsh-delete-session
```

### From a tarball

```sh
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-delete-session-0.1.0.tgz
```

After installing, **restart** `dsh web` (the host plugin and the served client bundle load at startup).

## Usage

1. Open **Settings** (the gear icon at the bottom of the sidebar)
2. A dedicated **Session Manager** section appears in the left navigation — click it
3. The main list shows unarchived sessions; the **Archived sessions** collapsible area at the bottom shows archived ones, also deletable
4. Click **Delete** and confirm — the session is removed immediately

## How it works

| Layer | Implementation |
|---|---|
| Host | `src/index.ts` registers the webserver route `POST /dsh-delete-session/delete`. It resolves the session via `ctx.sessionPersistence`, archives it first through `ctx.workspaceRegistry` (the official channel hides the row on every connected client immediately), then removes the log directory on disk; `ctx.agents` detects running sessions and refuses to delete them |
| Client | `src/client/index.ts` registers the dedicated section through the official `settings.section` slot, lists sessions (with the archived group) from the `useSessions` / `useWorkspaces` standard feeds, and calls the host route to delete; removed session ids are remembered in browser localStorage so a live session does not "resurrect" after refresh |

- Deletion goes through the official archive channel first: the sidebar hides the session immediately
- Workspace accounting (`sessionIds` slots / the archive set) is reconciled automatically on the next startup when the registry rebuilds its header index — no manual file editing
- No system-prompt changes, no new model-facing tools: zero impact on tokens and model behavior

## Limitations

- **Running sessions cannot be deleted** (button disabled and the host refuses); with multiple tabs, stop the session elsewhere first
- Subagent sessions cannot be deleted
- A live session (opened in this process) has its in-memory state cleaned up by DSH on restart; deleted ids are recorded in browser localStorage so they do not reappear after a refresh

## Compatibility

Current version targets DSH `0.1.0-rc.6` (depends on the `settings.section` slot and the `ctx.sessionPersistence` / `ctx.workspaceRegistry` / `ctx.agents` services). If slots or service APIs change in a future DSH version, the plugin needs a matching update.

## Development

```sh
pnpm install        # installs dependencies (@deepseek-ai packages are linked local dev dependencies)
pnpm run check      # typecheck + test + build
```

`lib/` holds the committed build artifacts: rebuild and commit `lib/` with every source change.
