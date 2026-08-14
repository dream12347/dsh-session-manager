/**
 * Wire contract shared by the host delete route and the web client panel.
 * Both halves only exchange JSON, so the contract is types plus a route
 * constant — no runtime import crosses the boundary.
 */

/** The host route the client panel calls to delete one session. */
export const DELETE_ROUTE = '/dsh-delete-session/delete'

/** POST /dsh-delete-session/delete request body. */
export interface DeleteSessionRequest {
  sessionId: string
}

/** POST /dsh-delete-session/delete response body. */
export interface DeleteSessionResponse {
  ok: boolean
  /** Machine-readable failure reason: invalid-session-id | session-not-found | subagent-session | no-artifact-location | delete-failed | bad-request | method-not-allowed. */
  error?: string
}
