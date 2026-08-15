/**
 * dsh-delete-session host plugin (v0.1.2: trash + restore).
 *
 * Routes:
 *   POST /dsh-delete-session/delete   body: { sessionId }  -> move to trash
 *   POST /dsh-delete-session/restore  body: { sessionId }  -> restore from trash
 *   POST /dsh-delete-session/purge    body: { sessionId }  -> permanently purge
 *   GET  /dsh-delete-session/trash                          -> list trash entries
 *
 * Delete flow (soft delete):
 *  1. Resolve the persisted session; refuse subagent-owned sessions and
 *     sessions whose agent is actively running a turn.
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
// Type-only: brings the ctx.webServer / ctx.sessionPersistence /
// ctx.workspaceRegistry / ctx.agents / ctx.storageDomain merges into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

export const name = 'dsh-delete-session'
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry', 'agents', 'storageDomain']

const ROUTE_PREFIX = '/dsh-delete-session'
const MAX_BODY_BYTES = 64 * 1024
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,}$/
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
export const TRASH_LIMIT = 10

const trashEntrySchema = z.object({
  sessionId: z.string(),
  cwd: z.string().optional(),
  originalPath: z.string().optional(),
  deletedAt: z.number(),
})
export type TrashEntry = z.infer<typeof trashEntrySchema>

/** The plugin's storage domain: one global array of trash entries. */
const trashDomainSpec = defineDomain({
  name: 'dsh_delete_session',
  version: 1,
  global: {
    schema: z.object({ entries: z.array(trashEntrySchema) }),
    initial: { entries: [] },
  },
  tables: {},
})

function trashRoot(): string {
  return dshHomePath('dsh-delete-session-trash')
}
function trashSessionDir(sessionId: string): string {
  return join(trashRoot(), sessionId)
}

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

/**
 * Sync the WorkspaceRegistry's private state cache with the durable domain
 * value. There is no public unarchive API; writing the domain directly leaves
 * the registry's cached state stale, so the next archiveSession() call would
 * idempotently skip on the old value. This pokes the private field to keep
 * both in lockstep. Fragile against a DSH upgrade, but the alternative is
 * silent un-archives/archives that disagree with what clients see.
 */
function syncRegistryState(ctx: Context, next: unknown): void {
  const registry = ctx.workspaceRegistry as unknown as { state?: unknown }
  if (registry !== undefined && 'state' in registry) {
    registry.state = next
  }
}

/** Remove one session id from the workspace archive set through the domain. */
async function unarchive(ctx: Context, sessionId: SessionId): Promise<void> {
  const workspace = ctx.storageDomain.get('workspace')
  if (workspace === undefined) return
  const state = workspace.global.get() as { archivedSessionIds: string[] }
  if (!state.archivedSessionIds.includes(sessionId)) return
  const next = {
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
  }
  await workspace.global.set(next)
  syncRegistryState(ctx, next)
}

export function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
    const getEntries = (): TrashEntry[] => (trash.global.get() as { entries: TrashEntry[] }).entries
    const setEntries = (entries: TrashEntry[]): Promise<void> =>
      trash.global.set({ entries }).catch((error) => {
        ctx.logger.warn('[dsh-delete-session] trash persist failed:', error)
        throw error
      })

    // POST /dsh-delete-session/delete — soft delete into the trash.
    ctx.webServer.register({
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
          const headers = await ctx.sessionPersistence.list()
          const meta = headers.find((header) => header.id === id)
          const agent = ctx.agents.get(id)
          const live = agent !== undefined

          if (meta?.origin === 'subagent') {
            return respond(res, 400, { ok: false, error: 'subagent-session' })
          }
          if (agent?.status === 'running') {
            return respond(res, 409, { ok: false, error: 'session-live' })
          }

          // Hide the row on every client through the official archive channel.
          // Archive FIRST: archiveSession's existence check reads persistence,
          // which would miss the session once its artifact is moved away.
          // If archiving fails, ABORT the delete: continuing would leave the
          // session listed while its artifact is gone (a broken session).
          try {
            await ctx.workspaceRegistry.archiveSession(id)
          } catch (error) {
            ctx.logger.warn(`[dsh-delete-session] archive failed for ${id}, aborting delete:`, error)
            return respond(res, 500, { ok: false, error: 'archive-failed' })
          }
          // archiveSession idempotently skips when its private cache already
          // holds the id — which can disagree with the durable domain after a
          // restore. Verify the durable value and patch it when missing, then
          // keep the cache in lockstep.
          {
            const workspace = ctx.storageDomain.get('workspace')
            if (workspace !== undefined) {
              const current = workspace.global.get() as { archivedSessionIds: string[] }
              if (!current.archivedSessionIds.includes(id)) {
                const next = { ...current, archivedSessionIds: [...current.archivedSessionIds, id] }
                await workspace.global.set(next)
                syncRegistryState(ctx, next)
                ctx.logger.debug(`[dsh-delete-session] patched archived set for ${id} (stale registry cache)`)
              }
            }
          }

          // Move the artifact directory into the trash ONLY for non-live
          // sessions. A live session keeps writing its log at the original
          // location; moving the directory would split history between the
          // trash and the rebuilt artifact. Its file is removed on purge.
          let originalPath: string | undefined
          if (meta !== undefined) {
            const location = ctx.sessionPersistence.locate(meta)
            if (location === undefined) return respond(res, 500, { ok: false, error: 'no-artifact-location' })
            originalPath = dirname(location.path)
          }
          if (!live && originalPath !== undefined && existsSync(originalPath)) {
            await mkdir(trashRoot(), { recursive: true })
            await rm(trashSessionDir(id), { recursive: true, force: true })
            await rename(originalPath, trashSessionDir(id))
            ctx.logger.debug(`[dsh-delete-session] moved ${id} artifact to trash`)
          }

          // Record the entry idempotently: an existing entry for this session
          // is refreshed (new delete time) instead of duplicated.
          const entries = getEntries()
          const existingIndex = entries.findIndex((entry) => entry.sessionId === id)
          let next: TrashEntry[]
          if (existingIndex >= 0) {
            next = entries.map((entry, index) => index === existingIndex ? { ...entry, deletedAt: Date.now() } : entry)
          } else {
            next = [...entries, { sessionId: id, cwd: meta?.cwd, originalPath, deletedAt: Date.now() }]
            if (next.length > TRASH_LIMIT) {
              const overflow = next.slice(0, next.length - TRASH_LIMIT)
              for (const entry of overflow) {
                await rm(trashSessionDir(entry.sessionId), { recursive: true, force: true }).catch(() => {})
              }
              next = next.slice(next.length - TRASH_LIMIT)
            }
          }
          await setEntries(next)

          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] delete failed:', error)
          respond(res, 500, { ok: false, error: 'delete-failed' })
        }
      },
    })

    // POST /dsh-delete-session/restore — move the artifact back and unarchive.
    ctx.webServer.register({
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
          const entries = getEntries()
          const entry = entries.find((candidate) => candidate.sessionId === id)

          // No trash entry: this is an archived-but-present session being
          // restored from the "已归档" group. Just un-archive it.
          if (entry === undefined) {
            const headers = await ctx.sessionPersistence.list()
            const meta = headers.find((header) => header.id === id)
            const agent = ctx.agents.get(id)
            if (meta === undefined && agent === undefined) {
              return respond(res, 404, { ok: false, error: 'trash-entry-not-found' })
            }
            await unarchive(ctx, id)
            ctx.logger.debug(`[dsh-delete-session] restore ${id}: no trash entry, un-archived only`)
            return respond(res, 200, { ok: true })
          }

          // Move the artifact back only when the trash actually holds one; a
          // live session's artifact was never moved, so nothing to do here.
          const from = trashSessionDir(id)
          if (existsSync(from)) {
            if (entry.originalPath === undefined) {
              ctx.logger.warn(`[dsh-delete-session] restore ${id}: artifact exists in trash but entry has no original path`)
              return respond(res, 500, { ok: false, error: 'no-original-path' })
            }
            if (existsSync(entry.originalPath)) {
              // The original location was recreated (a live session kept
              // writing there): keep the newer file, discard the trash copy.
              await rm(from, { recursive: true, force: true })
              ctx.logger.warn(`[dsh-delete-session] restore ${id}: original path already exists, discarding trash copy`)
            } else {
              await mkdir(dirname(entry.originalPath), { recursive: true })
              await rename(from, entry.originalPath)
              ctx.logger.debug(`[dsh-delete-session] restored ${id} artifact from trash`)
            }
          } else {
            ctx.logger.debug(`[dsh-delete-session] restore ${id}: no artifact in trash (live or blank session)`)
          }

          // Only now — artifact safely back — un-archive and drop the entry.
          await unarchive(ctx, id)
          await setEntries(entries.filter((candidate) => candidate.sessionId !== id))
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] restore failed:', error)
          respond(res, 500, { ok: false, error: 'restore-failed' })
        }
      },
    })

    // POST /dsh-delete-session/purge — permanently delete the trash entry.
    ctx.webServer.register({
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
          const entries = getEntries()
          const entry = entries.find((candidate) => candidate.sessionId === id)
          if (entry === undefined) return respond(res, 404, { ok: false, error: 'trash-entry-not-found' })

          // Remove the artifact: from the trash if it was moved there, and from
          // the original location too (a live session's artifact stayed put).
          await rm(trashSessionDir(id), { recursive: true, force: true })
          if (entry.originalPath !== undefined) {
            await rm(entry.originalPath, { recursive: true, force: true })
          }
          await setEntries(entries.filter((candidate) => candidate.sessionId !== id))
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] purge failed:', error)
          respond(res, 500, { ok: false, error: 'purge-failed' })
        }
      },
    })

    // POST /dsh-delete-session/pause — stop a running session's current turn.
    ctx.webServer.register({
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
          const agent = ctx.agents.get(id)
          if (agent === undefined) {
            return respond(res, 404, { ok: false, error: 'agent-not-found' })
          }
          agent.cancel({ kind: 'user' })
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] pause failed:', error)
          respond(res, 500, { ok: false, error: 'pause-failed' })
        }
      },
    })

    // GET /dsh-delete-session/trash — list trash entries.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/trash`,
      handler: async (_req, res) => {
        try {
          respond(res, 200, { ok: true, entries: getEntries(), limit: TRASH_LIMIT })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] trash list failed:', error)
          respond(res, 500, { ok: false, error: 'trash-list-failed' })
        }
      },
    })

    // POST /dsh-delete-session/open-folder — reveal a session's log directory
    // in the system file manager.
    ctx.webServer.register({
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
          // Prefer the live artifact location; fall back to the trash entry.
          let dir: string | undefined
          const headers = await ctx.sessionPersistence.list()
          const meta = headers.find((header) => header.id === id)
          if (meta !== undefined) {
            const location = ctx.sessionPersistence.locate(meta)
            if (location !== undefined) dir = dirname(location.path)
          }
          if (dir === undefined || !existsSync(dir)) {
            const entry = getEntries().find((candidate) => candidate.sessionId === id)
            if (entry?.originalPath !== undefined && existsSync(entry.originalPath)) {
              dir = entry.originalPath
            }
          }
          if (dir === undefined || !existsSync(dir)) {
            return respond(res, 404, { ok: false, error: 'folder-not-found' })
          }
          if (process.platform === 'win32') {
            spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref()
          } else {
            spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
          }
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-delete-session] open-folder failed:', error)
          respond(res, 500, { ok: false, error: 'open-folder-failed' })
        }
      },
    })

    return () => trash.close()
  })
}
