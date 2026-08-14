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
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings the ctx.webServer / ctx.sessionPersistence /
// ctx.workspaceRegistry / ctx.agents Context merges into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'dsh-delete-session'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'agents']

const ROUTE_PATH = '/dsh-delete-session/delete'
const MAX_BODY_BYTES = 64 * 1024
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,}$/

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => {
      if (data.length === 0) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        respond(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch {
        respond(res, 400, { ok: false, error: 'bad-request' })
        return
      }

      const sessionId = (body as { sessionId?: unknown } | null)?.sessionId
      if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
        respond(res, 400, { ok: false, error: 'invalid-session-id' })
        return
      }
      const id = sessionId as SessionId

      try {
        // 1) Resolve the persisted session and the live agent (if any).
        const headers = await ctx.sessionPersistence.list()
        const meta = headers.find((header) => header.id === id)
        const agent = ctx.agents.get(id)

        // 2) Refuse subagent-owned sessions.
        if (meta?.origin === 'subagent') {
          respond(res, 400, { ok: false, error: 'subagent-session' })
          return
        }

        // 3) Refuse a session whose agent is actively running a turn. An idle
        //    live session (open but quiet) is deletable: its artifact is removed,
        //    it is archived so every client hides it, and a restart drops the
        //    live entry — live state is never durable.
        if (agent?.status === 'running') {
          respond(res, 409, { ok: false, error: 'session-live' })
          return
        }

        // 4) Remove the on-disk artifact when the session is persisted. A
        //    blank session (created, never appended) has no artifact; archiving
        //    it still hides the row, and a restart forgets it entirely.
        if (meta !== undefined) {
          const location = ctx.sessionPersistence.locate(meta)
          if (location === undefined) {
            respond(res, 500, { ok: false, error: 'no-artifact-location' })
            return
          }
          await rm(dirname(location.path), { recursive: true, force: true })
        }

        // 5) Archive so clients hide the row through the official channel; an
        //    already-archived id is a no-op, and any failure is not fatal.
        await ctx.workspaceRegistry.archiveSession(id).catch(() => {})

        respond(res, 200, { ok: true })
      } catch (error) {
        ctx.logger.warn('[dsh-delete-session] delete failed:', error)
        respond(res, 500, { ok: false, error: 'delete-failed' })
      }
    },
  })
}
