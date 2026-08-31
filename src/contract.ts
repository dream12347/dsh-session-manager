/**
 * Wire contract shared by the host routes and the web client panel.
 * Both halves only exchange JSON, so the contract is types plus route
 * constants — no runtime import crosses the boundary.
 */

/** The host route the client panel calls to delete (move to trash) one session. */
export const DELETE_ROUTE = '/dsh-session-manager/delete'
/** Restore one session from the trash back to its original location. */
export const RESTORE_ROUTE = '/dsh-session-manager/restore'
/** Permanently purge one session from the trash. */
export const PURGE_ROUTE = '/dsh-session-manager/purge'
/** List the current trash contents. */
export const TRASH_ROUTE = '/dsh-session-manager/trash'
/** Reveal a session's log directory in the system file manager. */
export const OPEN_FOLDER_ROUTE = '/dsh-session-manager/open-folder'
/** Stop a running session's current turn (pause). */
export const PAUSE_ROUTE = '/dsh-session-manager/pause'
/** Write the context compaction threshold into the official compaction plugin config. */
export const COMPACTION_THRESHOLD_ROUTE = '/dsh-session-manager/compaction-threshold'
/** Read (GET) or update (POST) the host-side manual unread marker set. */
export const UNREAD_ROUTE = '/dsh-session-manager/unread'

/** POST /dsh-session-manager/delete request body. */
export interface DeleteSessionRequest {
  sessionId: string
}

/** POST /dsh-session-manager/restore and /purge request body. */
export interface TrashActionRequest {
  sessionId: string
}

/** One trash entry (host-side record, mirrored to the client). */
export interface TrashEntry {
  sessionId: string
  /** Working directory at delete time, when the session had one. */
  cwd?: string
  /** Original on-disk artifact directory, restored into on restore. */
  originalPath?: string
  /** Epoch ms when the session was moved to the trash. */
  deletedAt: number
}

/** POST delete/restore/purge response body. */
export interface ActionResultResponse {
  ok: boolean
  /** Machine-readable failure reason. */
  error?: string
}

/** GET /dsh-session-manager/trash response body. */
export interface TrashListResponse {
  ok: boolean
  entries: TrashEntry[]
  /** Maximum entries kept; the oldest overflow is purged automatically. */
  limit: number
}

/** POST /dsh-session-manager/unread request body. */
export interface UnreadSetRequest {
  sessionId: string
  unread: boolean
}

/** GET /dsh-session-manager/unread response body. */
export interface UnreadListResponse {
  ok: boolean
  /** The manually unread session ids. */
  ids: string[]
}

/** One session row of the host-side session list (`sessionManagerV1.list`). */
export interface SessionListItem {
  id: string
  /** Latest logged title, when the transcript carries one. */
  title?: string
  cwd?: string
  createdAt: number
  /** Last transcript event time (createdAt for an empty/unreadable log). */
  updatedAt: number
  archived: boolean
  running: boolean
  inTrash: boolean
}

/** `sessionManagerV1.list` result. */
export interface SessionListResponse {
  ok: boolean
  sessions: SessionListItem[]
}

/** Folded recent-activity statistics for one session (same counting rules as
 * the web client: turn starts, user/assistant messages, tool calls grouped
 * by name, and the activity window's first/last event times). */
export interface SessionStats {
  turns: number
  userMessages: number
  assistantMessages: number
  toolCalls: { name: string; count: number }[]
  startedAt: number
  updatedAt: number
}

/** `sessionManagerV1.stats` result. */
export interface SessionStatsResponse {
  ok: boolean
  stats?: SessionStats
  /** Machine-readable failure reason. */
  error?: string
}
