/**
 * dsh-session-manager host plugin (v0.1.2: trash + restore).
 *
 * The domain logic lives in the `sessionManagerV1` Cordis service
 * (src/service.ts); this entry owns the plugin wiring: the storage domain
 * registration, the agent/pre-step threshold-enforcement hook, and — only
 * when the host runs a web server — the HTTP routes, which are thin wrappers
 * over the service (parse body -> call service -> serialize the result).
 * Blue's TUI profile has no webServer, so routes are skipped there and the
 * service is consumed through the `sessionManagerV1` inject instead.
 *
 * Routes:
 *   POST /dsh-session-manager/delete   body: { sessionId }  -> move to trash
 *   POST /dsh-session-manager/restore  body: { sessionId }  -> restore from trash
 *   POST /dsh-session-manager/purge    body: { sessionId }  -> permanently purge
 *   GET  /dsh-session-manager/trash                          -> list trash entries
 *   GET/POST /dsh-session-manager/unread                     -> read/update unread marks
 *
 * Delete flow (soft delete):
 *  1. Resolve the persisted session; refuse sessions whose agent is actively
 *     running a turn.
 *  2. Move the session's artifact directory into the plugin trash folder
 *     (a blank session without an artifact just records the entry).
 *  3. Archive the session so every client hides the row immediately.
 *  4. Record the entry (original path + deletedAt) in the plugin's storage
 *     domain; when the trash exceeds the limit, the oldest entries are
 *     purged for good.
 *
 * Restore flow:
 *  1. Find the trash entry; move the artifact back to its original path.
 *  2. Remove the session id from the workspace archive set through the
 *     workspace domain (the official broadcast refreshes every client).
 *  3. Drop the trash entry.
 *
 * Purge flow: remove the artifact directory and the trash entry.
 */
import type { Context } from '@deepseek-ai/cordis';
export { openFolderCommand, SessionManagerV1, TRASH_LIMIT } from './service.ts';
export type { TrashEntry } from './service.ts';
export declare const name = "dsh-session-manager";
export declare const inject: string[];
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
//# sourceMappingURL=index.d.ts.map