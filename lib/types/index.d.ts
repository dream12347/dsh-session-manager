/**
 * dsh-session-manager host plugin (v0.1.2: trash + restore).
 *
 * Routes:
 *   POST /dsh-session-manager/delete   body: { sessionId }  -> move to trash
 *   POST /dsh-session-manager/restore  body: { sessionId }  -> restore from trash
 *   POST /dsh-session-manager/purge    body: { sessionId }  -> permanently purge
 *   GET  /dsh-session-manager/trash                          -> list trash entries
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
import { z } from 'zod';
export declare const name = "dsh-session-manager";
export declare const inject: string[];
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
export declare const TRASH_LIMIT = 10;
declare const trashEntrySchema: z.ZodObject<{
    sessionId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    originalPath: z.ZodOptional<z.ZodString>;
    deletedAt: z.ZodNumber;
}, z.core.$strip>;
export type TrashEntry = z.infer<typeof trashEntrySchema>;
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
export {};
//# sourceMappingURL=index.d.ts.map