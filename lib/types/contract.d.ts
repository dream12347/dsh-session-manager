/**
 * Wire contract shared by the host routes and the web client panel.
 * Both halves only exchange JSON, so the contract is types plus route
 * constants — no runtime import crosses the boundary.
 */
/** The host route the client panel calls to delete (move to trash) one session. */
export declare const DELETE_ROUTE = "/dsh-delete-session/delete";
/** Restore one session from the trash back to its original location. */
export declare const RESTORE_ROUTE = "/dsh-delete-session/restore";
/** Permanently purge one session from the trash. */
export declare const PURGE_ROUTE = "/dsh-delete-session/purge";
/** List the current trash contents. */
export declare const TRASH_ROUTE = "/dsh-delete-session/trash";
/** Reveal a session's log directory in the system file manager. */
export declare const OPEN_FOLDER_ROUTE = "/dsh-delete-session/open-folder";
/** Stop a running session's current turn (pause). */
export declare const PAUSE_ROUTE = "/dsh-delete-session/pause";
/** POST /dsh-delete-session/delete request body. */
export interface DeleteSessionRequest {
    sessionId: string;
}
/** POST /dsh-delete-session/restore and /purge request body. */
export interface TrashActionRequest {
    sessionId: string;
}
/** One trash entry (host-side record, mirrored to the client). */
export interface TrashEntry {
    sessionId: string;
    /** Working directory at delete time, when the session had one. */
    cwd?: string;
    /** Original on-disk artifact directory, restored into on restore. */
    originalPath?: string;
    /** Epoch ms when the session was moved to the trash. */
    deletedAt: number;
}
/** POST delete/restore/purge response body. */
export interface ActionResultResponse {
    ok: boolean;
    /** Machine-readable failure reason. */
    error?: string;
}
/** GET /dsh-delete-session/trash response body. */
export interface TrashListResponse {
    ok: boolean;
    entries: TrashEntry[];
    /** Maximum entries kept; the oldest overflow is purged automatically. */
    limit: number;
}
//# sourceMappingURL=contract.d.ts.map