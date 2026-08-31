/**
 * sessionManagerV1 Cordis service: the domain half of dsh-session-manager.
 *
 * Every HTTP route handler in the plugin entry is a thin wrapper over one
 * method here; Blue's TUI profile (no webServer) consumes the same service
 * directly through the `sessionManagerV1` inject. Methods only accept and
 * return JSON-shaped data — Agent/Session objects never cross the boundary.
 *
 * Semantics preserved from the original route handlers: the mutation lock,
 * the trash overflow purge past TRASH_LIMIT, the delete rollback (artifact
 * moved back + unarchive), the two restore modes, purge's double removal,
 * pause's `agent.cancel({ kind: 'user' })`, and the threshold's three-step
 * write (storage domain + user preset composition upsert + live agents).
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { ActionResultResponse, SessionListResponse, SessionStatsResponse, TrashListResponse, UnreadListResponse } from './contract.ts';
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
export declare const TRASH_LIMIT = 10;
export declare function openFolderCommand(platform: NodeJS.Platform): string;
declare const trashEntrySchema: z.ZodObject<{
    sessionId: z.ZodString;
    cwd: z.ZodOptional<z.ZodString>;
    originalPath: z.ZodOptional<z.ZodString>;
    deletedAt: z.ZodNumber;
}, z.core.$strip>;
export type TrashEntry = z.infer<typeof trashEntrySchema>;
/**
 * The plugin's storage domain: trash entries, the compaction threshold
 * setting, and the manual unread marker set. The version stays 1: the domain
 * runtime rejects a medium stamped with a different version at open (there
 * is no migration mechanism), so `unreadIds` is additive through a zod
 * default — pre-existing version-1 globals parse unchanged.
 */
export declare const trashDomainSpec: {
    name: string;
    version: number;
    global: {
        schema: z.ZodObject<{
            entries: z.ZodArray<z.ZodObject<{
                sessionId: z.ZodString;
                cwd: z.ZodOptional<z.ZodString>;
                originalPath: z.ZodOptional<z.ZodString>;
                deletedAt: z.ZodNumber;
            }, z.core.$strip>>;
            thresholdRatio: z.ZodOptional<z.ZodNumber>;
            unreadIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>;
        initial: {
            entries: never[];
            unreadIds: never[];
        };
    };
    tables: {};
};
declare module '@deepseek-ai/cordis' {
    interface Context {
        sessionManagerV1: SessionManagerV1;
    }
    interface Events {
        /**
         * The manual unread marker set changed, emitted once per durable write
         * with the full new id list.
         * @mode emit
         */
        'dsh-session-manager/unread-changed'(ids: string[]): void;
    }
}
/**
 * The `sessionManagerV1` service: trash/restore/purge, pause, open-folder,
 * the compaction threshold, the session list, per-session activity stats, and
 * the manual unread marker set. Constructed by the plugin entry once the
 * storage domain is open; registered on the context through the Service base.
 */
export declare class SessionManagerV1 extends Service {
    private readonly trash;
    private mutationTail;
    private configuredThreshold;
    constructor(ctx: Context, trash: Domain<typeof trashDomainSpec>);
    /** The configured compaction threshold (null = not set), read by the
     * agent/pre-step enforcement hook registered in the plugin entry. */
    get configuredThresholdRatio(): number | null;
    private getEntries;
    private setEntries;
    private withMutationLock;
    /** Soft delete: move the session's artifact into the trash and archive it. */
    delete(sessionId: SessionId): Promise<ActionResultResponse>;
    /** Restore: move the artifact back and un-archive, or un-archive only when
     * no trash entry exists (an archived-but-present session). */
    restore(sessionId: SessionId): Promise<ActionResultResponse>;
    /** Permanently delete one trash entry and its artifact(s). */
    purge(sessionId: SessionId): Promise<ActionResultResponse>;
    /** Stop a running session's current turn. */
    pause(sessionId: SessionId): Promise<ActionResultResponse>;
    /** Reveal a session's log directory in the system file manager. */
    openFolder(sessionId: SessionId): Promise<ActionResultResponse>;
    /** List the current trash contents. */
    listTrash(): TrashListResponse;
    /**
     * Read the user-set compaction threshold. Storage is authoritative once
     * set; before the first save, fall back to the default preset file so an
     * existing value shows up.
     */
    getThreshold(): Promise<{
        ok: boolean;
        ratio: number;
    }>;
    /**
     * Update the compaction threshold: persist it in this plugin's storage
     * domain, write it into a user preset's composition file when available
     * (system preset files are read-only), and apply it to live agents. It is
     * still enforced on EVERY session's engine at each step boundary by the
     * plugin entry's hook and survives restarts through the storage domain.
     */
    setThreshold(ratio: number): Promise<ActionResultResponse>;
    /**
     * List every persisted session as JSON rows for the TUI: header facts from
     * `sessionPersistence.list()`, the archive flag from the workspace
     * registry, the running flag from the live agent registry, and the trash
     * flag from this plugin's entries. Title and updatedAt are folded from the
     * durable transcript (the last `session/title` event and the last event
     * time); a session whose log cannot be inspected still lists, header-only.
     */
    list(): Promise<SessionListResponse>;
    /** Recent-activity statistics for one session, folded host-side from the
     * durable transcript (see foldSessionStats for the counting rules). */
    stats(sessionId: SessionId): Promise<SessionStatsResponse>;
    /** The current manual unread marker set. */
    getUnread(): UnreadListResponse;
    /** Mark one session unread/read; emits `dsh-session-manager/unread-changed`
     * with the full new set after the durable write. */
    setUnread(sessionId: SessionId, unread: boolean): Promise<ActionResultResponse>;
}
export {};
//# sourceMappingURL=service.d.ts.map