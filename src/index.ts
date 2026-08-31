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
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings the ctx.webServer merge into this program (the service is
// resolved softly at runtime, so the merge is types only).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
// Type-only: brings the ctx.agentPresets service merge into this program.
import type {} from '@deepseek-ai/dsh-agent-presets'
// Type-only: brings the ctx.loader merge into this program (the loader is no
// longer injected; the merge stays for the declaration).
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ActionResultResponse, UnreadSetRequest } from './contract.ts'
import { SessionManagerV1, trashDomainSpec } from './service.ts'

export { openFolderCommand, SessionManagerV1, TRASH_LIMIT } from './service.ts'
export type { TrashEntry } from './service.ts'

export const name = 'dsh-session-manager'
// webServer is deliberately NOT injected: Blue's TUI profile has none, and
// the routes below are registered only when ctx.get('webServer') resolves.
// The loader was never used at runtime (type-only import above).
export const inject = [
  'sessionPersistence',
  'workspaceRegistry',
  'agents',
  'storageDomain',
  'agentPresets',
]

const ROUTE_PREFIX = '/dsh-session-manager'
const MAX_BODY_BYTES = 64 * 1024
// Official session ids come in three shapes: `session-<uuid>` (web UI,
// created via the api), `session-<n>` (store-minted, e.g. forks created
// without an explicit id) and `<uuid>` (subagent children, created as
// `SessionId(randomUUID())`). Accept all three; keep the charset tight
// (hex + dashes only, plus the literal "session-" prefix) because the id
// is joined into a trash path.
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/

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

function parseSessionId(body: unknown): SessionId | undefined {
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return undefined
  return sessionId as SessionId
}

/** The service's machine-readable error codes mapped onto HTTP statuses;
 * unknown codes (including thrown exception messages) stay 500. */
const STATUS_BY_ERROR: Record<string, number> = {
  'session-live': 409,
  'trash-entry-not-found': 404,
  'agent-not-found': 404,
  'folder-not-found': 404,
}

function statusOf(result: ActionResultResponse): number {
  if (result.ok) return 200
  return STATUS_BY_ERROR[result.error ?? ''] ?? 500
}

export function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
    const service = new SessionManagerV1(ctx, trash)

    // Enforce the configured threshold on every session's compaction engine
    // at each step boundary, whatever preset the session uses. The engine
    // reads `this.config` per decision, so the assignment is enough. Silent
    // and cheap (one comparison); never blocks the step.
    {
      const presets = ctx.get('agentPresets') as
        | { serviceFor?(agent: { ctx: Context }, name: string): unknown }
        | undefined
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        try {
          const configuredThreshold = service.configuredThresholdRatio
          if (configuredThreshold !== null && presets?.serviceFor !== undefined) {
            const engine = presets.serviceFor(agent, 'compaction') as
              | { config?: { thresholdRatio?: unknown } }
              | undefined
            if (engine?.config !== undefined && engine.config.thresholdRatio !== configuredThreshold) {
              engine.config.thresholdRatio = configuredThreshold
            }
          }
        } catch {
          // Never let enforcement break a step.
        }
        return next()
      }, { prepend: true })
    }

    // Routes exist only when the host runs a web server; Blue's TUI profile
    // has none, and the plugin still activates (the TUI talks to the service).
    const webServer = ctx.get('webServer') as WebServer | undefined
    if (webServer === undefined) {
      ctx.logger.debug('[dsh-session-manager] no webServer service, skipping route registration')
      return () => trash.close()
    }

    // POST /dsh-session-manager/delete — soft delete into the trash.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const result = await service.delete(id)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] delete failed:', error)
          respond(res, 500, { ok: false, error: 'delete-failed' })
        }
      },
    })

    // POST /dsh-session-manager/restore — move the artifact back and unarchive.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restore`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const result = await service.restore(id)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] restore failed:', error)
          respond(res, 500, { ok: false, error: 'restore-failed' })
        }
      },
    })

    // POST /dsh-session-manager/purge — permanently delete the trash entry.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const result = await service.purge(id)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] purge failed:', error)
          respond(res, 500, { ok: false, error: 'purge-failed' })
        }
      },
    })

    // POST /dsh-session-manager/pause — stop a running session's current turn.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/pause`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const result = await service.pause(id)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] pause failed:', error)
          respond(res, 500, { ok: false, error: 'pause-failed' })
        }
      },
    })

    // GET /dsh-session-manager/trash — list trash entries.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/trash`,
      handler: async (_req, res) => {
        try {
          respond(res, 200, service.listTrash())
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] trash list failed:', error)
          respond(res, 500, { ok: false, error: 'trash-list-failed' })
        }
      },
    })

    // GET/POST /dsh-session-manager/compaction-threshold — read or update the
    // user-set threshold. The value is persisted in this plugin's storage
    // domain and written to a user preset's composition file when available.
    // System preset files are read-only, so they are never modified; the
    // threshold is still enforced on EVERY session's engine at each step
    // boundary and survives restarts through the storage domain.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/compaction-threshold`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          respond(res, 200, await service.getThreshold())
          return
        }
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const ratio = (body as { ratio?: unknown } | null)?.ratio
        // The engine requires thresholdRatio > retainRatio (default 0.16).
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.17 || ratio > 0.9) {
          return respond(res, 400, { ok: false, error: 'invalid-ratio' })
        }
        try {
          const result = await service.setThreshold(ratio)
          respond(res, statusOf(result), result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn('[dsh-session-manager] compaction-threshold update failed:', error)
          respond(res, 500, { ok: false, error: message })
        }
      },
    })

    // GET/POST /dsh-session-manager/unread — read or update the manual unread
    // marker set persisted in this plugin's storage domain.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/unread`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            respond(res, 200, service.getUnread())
          } catch (error) {
            ctx.logger.warn('[dsh-session-manager] unread list failed:', error)
            respond(res, 500, { ok: false, error: 'unread-list-failed' })
          }
          return
        }
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })
        const unread = (body as Partial<UnreadSetRequest> | null)?.unread
        if (typeof unread !== 'boolean') return respond(res, 400, { ok: false, error: 'bad-request' })

        try {
          const result = await service.setUnread(id, unread)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] unread update failed:', error)
          respond(res, 500, { ok: false, error: 'unread-update-failed' })
        }
      },
    })

    // POST /dsh-session-manager/open-folder — reveal a session's log directory
    // in the system file manager.
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/open-folder`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const result = await service.openFolder(id)
          respond(res, statusOf(result), result)
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] open-folder failed:', error)
          respond(res, 500, { ok: false, error: 'open-folder-failed' })
        }
      },
    })

    return () => trash.close()
  })
}
