/**
 * dsh-delete-session host plugin.
 *
 * Exposes one webserver route:
 *   POST /dsh-delete-session/delete  body: { sessionId: string }
 *
 * The delete flow:
 *  1. Resolve the session in session persistence (404 when absent).
 *  2. Refuse subagent-owned sessions (their lifecycle belongs to delegation).
 *  3. Archive the session first — the official archive path broadcasts
 *     `domain/changed`, so every connected client hides the row immediately.
 *  4. Physically remove the session's log directory (located via
 *     `sessionPersistence.locate`, whose path points at the artifact file).
 *  5. Workspace accounting (sessionIds slots / the archive set) is reconciled
 *     on the next boot: the registry rebuilds its header index from
 *     persistence and filters members whose log no longer exists.
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-delete-session";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map