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
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings the ctx.sessionPersistence / ctx.workspaceRegistry /
// ctx.agents / ctx.storageDomain merges into this program.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: brings the 'session/title' SessionEventMap merge (title folding
// in list()) into this program.
import type {} from '@deepseek-ai/dsh-session-title'
// Type-only: brings the ctx.agentPresets service merge into this program.
import type {} from '@deepseek-ai/dsh-agent-presets'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineDomain, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import type {
  ActionResultResponse,
  SessionListItem,
  SessionListResponse,
  SessionStats,
  SessionStatsResponse,
  TrashListResponse,
  UnreadListResponse,
} from './contract.ts'

/** Maximum trash entries kept; the oldest overflow is purged automatically. */
export const TRASH_LIMIT = 10

export function openFolderCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'explorer'
  if (platform === 'darwin') return 'open'
  return 'xdg-open'
}

function openFolder(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(openFolderCommand(platform), [path], {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const trashEntrySchema = z.object({
  sessionId: z.string(),
  cwd: z.string().optional(),
  originalPath: z.string().optional(),
  deletedAt: z.number(),
})
export type TrashEntry = z.infer<typeof trashEntrySchema>

/** The trash domain's global value shape. The domain runtime validates the
 * stored global through the spec's zod schema at the durable boundary; the
 * casts below mirror the original plugin code. */
interface TrashGlobal {
  entries: TrashEntry[]
  thresholdRatio?: number
  unreadIds: string[]
}

/**
 * The plugin's storage domain: trash entries, the compaction threshold
 * setting, and the manual unread marker set. The version stays 1: the domain
 * runtime rejects a medium stamped with a different version at open (there
 * is no migration mechanism), so `unreadIds` is additive through a zod
 * default — pre-existing version-1 globals parse unchanged.
 */
export const trashDomainSpec = defineDomain({
  name: 'dsh_delete_session',
  version: 1,
  global: {
    schema: z.object({
      entries: z.array(trashEntrySchema),
      // User-set compaction threshold (0.17–0.9); absent = not configured.
      thresholdRatio: z.number().optional(),
      // Manual unread session ids (lifted from the web client's localStorage).
      unreadIds: z.array(z.string()).default([]),
    }),
    initial: { entries: [], unreadIds: [] },
  },
  tables: {},
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionManagerV1: SessionManagerV1
  }
  interface Events {
    /**
     * The manual unread marker set changed, emitted once per durable write
     * with the full new id list.
     * @mode emit
     */
    'dsh-session-manager/unread-changed'(ids: string[]): void
  }
}

function trashRoot(): string {
  return dshHomePath('dsh-delete-session-trash')
}
function trashSessionDir(sessionId: string): string {
  return join(trashRoot(), sessionId)
}

/**
 * In web mode the official composition disables the root `compaction-basic`
 * entry; the live compaction engine lives inside the agent preset's isolated
 * realm (the preset's `agent.cordis.yml`, in the `compaction` group). The
 * agent-presets service resolves the real file, including system presets that
 * ship with DSH; user preset files are updated line-by-line so comments stay
 * intact, while system preset files remain read-only.
 */

interface ResolvedPresetComposition {
  path: string
  trust: 'system' | 'user'
}

/** Resolve the active default preset through the official agent-presets service. */
function defaultPresetName(ctx: Context): string {
  const presets = ctx.get('agentPresets') as { defaultId?: unknown }
  if (typeof presets.defaultId !== 'string' || presets.defaultId.length === 0) {
    throw new Error('agent presets default id unavailable')
  }
  return presets.defaultId
}

/** Resolve the real composition path and trust instead of assuming a user path. */
async function resolvePresetComposition(ctx: Context, name: string): Promise<ResolvedPresetComposition> {
  const presets = ctx.get('agentPresets') as {
    resolve(id?: string): Promise<{ path?: unknown; trust?: unknown }>
  }
  const preset = await presets.resolve(name)
  if (typeof preset.path !== 'string' || preset.path.length === 0) {
    throw new Error(`agent preset composition path unavailable: ${name}`)
  }
  if (preset.trust !== 'system' && preset.trust !== 'user') {
    throw new Error(`agent preset trust unavailable: ${name}`)
  }
  return { path: preset.path, trust: preset.trust }
}

/** Read `thresholdRatio` from the preset's compaction-basic block, if any. */
function parsePresetRatio(content: string): number | undefined {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line))
  if (start < 0) return undefined
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- id: /.test(lines[i])) break
    const match = lines[i].match(/^\s*thresholdRatio:\s*([0-9.]+)\s*$/)
    if (match !== null) return Number(match[1])
  }
  return undefined
}

/**
 * Update `thresholdRatio` inside the preset's `- id: compaction-basic` block:
 * reuse the existing `config:`/`thresholdRatio:` lines or insert them with
 * the block's indentation. Existing content and comments stay untouched.
 */
function upsertPresetRatio(content: string, newline: string, ratio: number): string {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line))
  if (start < 0) throw new Error('preset compaction-basic entry not found')
  const indentOf = (line: string): string => (line.match(/^\s*/) ?? [''])[0]
  const base = indentOf(lines[start])
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- id: /.test(lines[i])) {
      end = i
      break
    }
  }
  const configLine = `${base}  config:`
  const ratioLine = `${base}    thresholdRatio: ${ratio}`
  let configIdx = -1
  for (let i = start + 1; i < end; i++) {
    if (/^\s*config:\s*$/.test(lines[i])) {
      configIdx = i
      break
    }
  }
  if (configIdx >= 0) {
    const configIndent = indentOf(lines[configIdx])
    let ratioIdx = -1
    for (let i = configIdx + 1; i < end; i++) {
      if (/^\s*thresholdRatio:/.test(lines[i])) {
        ratioIdx = i
        break
      }
      if (indentOf(lines[i]).length <= configIndent.length && /^\S/.test(lines[i])) break
    }
    if (ratioIdx >= 0) {
      lines[ratioIdx] = `${configIndent}  thresholdRatio: ${ratio}`
    } else {
      lines.splice(configIdx + 1, 0, `${configIndent}  thresholdRatio: ${ratio}`)
    }
  } else {
    lines.splice(end, 0, configLine, ratioLine)
  }
  return lines.join(newline)
}

/** Read the preset file, atomically write the updated content back. */
async function writePresetComposition(path: string, ratio: number): Promise<void> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(`preset composition file not found: ${path}`)
  }
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  let next = upsertPresetRatio(content, newline, ratio)
  if (!next.endsWith(newline)) next += newline
  const tmp = `${path}.tmp`
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, path)
}

/**
 * Sync the WorkspaceRegistry's private state cache with the durable domain
 * value. There is no public unarchive API; writing the domain directly leaves
 * the registry's cached state stale, so the next archiveSession() call would
 * idempotently skip on the old value. This pokes the private field to keep
 * both in lockstep. Fragile against a DSH upgrade, but the alternative is
 * silent un-archives/archives that disagree with what clients see. Remove
 * this once DSH ships a public unarchive API.
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

/**
 * Apply a new threshold to the compaction engines of already-open sessions.
 * Sessions using the same preset share one engine in the preset's isolated
 * realm; the agentPresets service's `serviceFor` is the official channel
 * that reaches it (called on the HOST's service instance, so module state is
 * shared). The engine reads `this.config` at every decision, so updating the
 * resolved threshold field takes effect immediately. Fragile: it writes the
 * engine's private `config.thresholdRatio`; remove once the compaction
 * plugin exposes a public configuration API. Best-effort: failures only warn.
 */
async function applyThresholdToLiveAgents(ctx: Context, ratio: number): Promise<void> {
  try {
    const presets = ctx.get('agentPresets') as
      | { serviceFor?(agent: { ctx: Context }, name: string): unknown }
      | undefined
    if (presets?.serviceFor === undefined) return
    const headers = await ctx.sessionPersistence.list()
    for (const header of headers) {
      const agent = ctx.agents.get(header.id)
      if (agent === undefined) continue
      const engine = presets.serviceFor(agent, 'compaction') as
        | { config?: { thresholdRatio?: unknown } }
        | undefined
      if (engine === undefined || engine.config === undefined) continue
      engine.config.thresholdRatio = ratio
    }
  } catch (error) {
    ctx.logger.warn('[dsh-session-manager] live-agent threshold update failed:', error)
  }
}

/**
 * Fold a session log into recent-activity statistics. Same counting rules as
 * the web client's foldStats: `turn/start` events count as turns, tool calls
 * group by name (sorted by count descending), and the activity window spans
 * the first to the last event time. The web client folds the tail page of
 * the `session.history` RPC; the host folds the full durable transcript, so
 * a long session's host stats cover its whole log instead of the recent page.
 */
function foldSessionStats(events: readonly SessionEvent[]): SessionStats {
  let turns = 0
  let userMessages = 0
  let assistantMessages = 0
  const toolCounts = new Map<string, number>()
  let startedAt = Number.POSITIVE_INFINITY
  let updatedAt = Number.NEGATIVE_INFINITY
  for (const event of events) {
    if (event.time < startedAt) startedAt = event.time
    if (event.time > updatedAt) updatedAt = event.time
    if (event.type === 'turn/start') turns += 1
    else if (event.type === 'user/message') userMessages += 1
    else if (event.type === 'assistant/message') assistantMessages += 1
    else if (event.type === 'tool/call') {
      toolCounts.set(event.data.name, (toolCounts.get(event.data.name) ?? 0) + 1)
    }
  }
  const toolCalls = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return {
    turns,
    userMessages,
    assistantMessages,
    toolCalls,
    startedAt: startedAt === Number.POSITIVE_INFINITY ? 0 : startedAt,
    updatedAt: updatedAt === Number.NEGATIVE_INFINITY ? 0 : updatedAt,
  }
}

/**
 * The `sessionManagerV1` service: trash/restore/purge, pause, open-folder,
 * the compaction threshold, the session list, per-session activity stats, and
 * the manual unread marker set. Constructed by the plugin entry once the
 * storage domain is open; registered on the context through the Service base.
 */
export class SessionManagerV1 extends Service {
  private readonly trash: Domain<typeof trashDomainSpec>
  private mutationTail: Promise<void> = Promise.resolve()
  // The user-set compaction threshold, persisted in this plugin's storage
  // domain. Loaded at startup; updated on save. It applies to EVERY session
  // regardless of agent preset: the agent/pre-step enforcement hook in the
  // plugin entry forces the running engine's config to this value.
  private configuredThreshold: number | null

  constructor(ctx: Context, trash: Domain<typeof trashDomainSpec>) {
    super(ctx, 'sessionManagerV1')
    this.trash = trash
    this.configuredThreshold = (trash.global.get() as TrashGlobal).thresholdRatio ?? null
  }

  /** The configured compaction threshold (null = not set), read by the
   * agent/pre-step enforcement hook registered in the plugin entry. */
  get configuredThresholdRatio(): number | null {
    return this.configuredThreshold
  }

  private getEntries(): TrashEntry[] {
    return (this.trash.global.get() as TrashGlobal).entries
  }

  private setEntries(entries: TrashEntry[]): Promise<void> {
    const current = this.trash.global.get() as TrashGlobal
    return this.trash.global.set({ ...current, entries }).catch((error) => {
      this.ctx.logger.warn('[dsh-session-manager] trash persist failed:', error)
      throw error
    })
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Soft delete: move the session's artifact into the trash and archive it. */
  async delete(sessionId: SessionId): Promise<ActionResultResponse> {
    return this.withMutationLock(async () => {
      const headers = await this.ctx.sessionPersistence.list()
      const meta = headers.find((header) => header.id === sessionId)
      const agent = this.ctx.agents.get(sessionId)
      const live = agent !== undefined

      if (agent?.status === 'running') {
        return { ok: false, error: 'session-live' }
      }

      let originalPath: string | undefined
      if (meta !== undefined) {
        const location = this.ctx.sessionPersistence.locate(meta)
        if (location === undefined) {
          return { ok: false, error: 'no-artifact-location' }
        }
        originalPath = dirname(location.path)
      }

      const workspace = this.ctx.storageDomain.get('workspace')
      const wasArchived = workspace !== undefined
        && (workspace.global.get() as { archivedSessionIds: string[] }).archivedSessionIds.includes(sessionId)
      const trashPath = trashSessionDir(sessionId)
      let archiveStarted = false
      let artifactMoved = false
      let failureCode = 'delete-failed'

      try {
        failureCode = 'archive-failed'
        archiveStarted = true
        await this.ctx.workspaceRegistry.archiveSession(sessionId)
        failureCode = 'delete-failed'

        {
          const currentWorkspace = this.ctx.storageDomain.get('workspace')
          if (currentWorkspace !== undefined) {
            const current = currentWorkspace.global.get() as { archivedSessionIds: string[] }
            if (!current.archivedSessionIds.includes(sessionId)) {
              const next = { ...current, archivedSessionIds: [...current.archivedSessionIds, sessionId] }
              await currentWorkspace.global.set(next)
              syncRegistryState(this.ctx, next)
              this.ctx.logger.debug(`[dsh-session-manager] patched archived set for ${sessionId} (stale registry cache)`)
            }
          }
        }

        if (!live && originalPath !== undefined && existsSync(originalPath)) {
          await mkdir(trashRoot(), { recursive: true })
          await rm(trashPath, { recursive: true, force: true })
          await rename(originalPath, trashPath)
          artifactMoved = true
          this.ctx.logger.debug(`[dsh-session-manager] moved ${sessionId} artifact to trash`)
        }

        const entries = this.getEntries()
        const existingIndex = entries.findIndex((entry) => entry.sessionId === sessionId)
        let next: TrashEntry[]
        let overflow: TrashEntry[] = []
        if (existingIndex >= 0) {
          next = entries.map((entry, index) => index === existingIndex ? { ...entry, deletedAt: Date.now() } : entry)
        } else {
          next = [...entries, { sessionId, cwd: meta?.cwd, originalPath, deletedAt: Date.now() }]
          if (next.length > TRASH_LIMIT) {
            overflow = next.slice(0, next.length - TRASH_LIMIT)
            next = next.slice(next.length - TRASH_LIMIT)
          }
        }
        await this.setEntries(next)
        for (const entry of overflow) {
          await rm(trashSessionDir(entry.sessionId), { recursive: true, force: true }).catch(() => {})
        }

        return { ok: true }
      } catch (error) {
        if (artifactMoved && originalPath !== undefined && existsSync(trashPath) && !existsSync(originalPath)) {
          try {
            await mkdir(dirname(originalPath), { recursive: true })
            await rename(trashPath, originalPath)
          } catch (rollbackError) {
            this.ctx.logger.warn(`[dsh-session-manager] artifact rollback failed for ${sessionId}:`, rollbackError)
          }
        }
        if (archiveStarted && !wasArchived) {
          try {
            await unarchive(this.ctx, sessionId)
          } catch (rollbackError) {
            this.ctx.logger.warn(`[dsh-session-manager] archive rollback failed for ${sessionId}:`, rollbackError)
          }
        }
        this.ctx.logger.warn(`[dsh-session-manager] ${failureCode} for ${sessionId}:`, error)
        return { ok: false, error: failureCode }
      }
    })
  }

  /** Restore: move the artifact back and un-archive, or un-archive only when
   * no trash entry exists (an archived-but-present session). */
  async restore(sessionId: SessionId): Promise<ActionResultResponse> {
    return this.withMutationLock(async () => {
      const entries = this.getEntries()
      const entry = entries.find((candidate) => candidate.sessionId === sessionId)

      // No trash entry: this is an archived-but-present session being
      // restored from the "已归档" group. Just un-archive it.
      if (entry === undefined) {
        const headers = await this.ctx.sessionPersistence.list()
        const meta = headers.find((header) => header.id === sessionId)
        const agent = this.ctx.agents.get(sessionId)
        if (meta === undefined && agent === undefined) {
          return { ok: false, error: 'trash-entry-not-found' }
        }
        await unarchive(this.ctx, sessionId)
        this.ctx.logger.debug(`[dsh-session-manager] restore ${sessionId}: no trash entry, un-archived only`)
        return { ok: true }
      }

      // Move the artifact back only when the trash actually holds one; a
      // live session's artifact was never moved, so nothing to do here.
      const from = trashSessionDir(sessionId)
      if (existsSync(from)) {
        if (entry.originalPath === undefined) {
          this.ctx.logger.warn(`[dsh-session-manager] restore ${sessionId}: artifact exists in trash but entry has no original path`)
          return { ok: false, error: 'no-original-path' }
        }
        if (existsSync(entry.originalPath)) {
          // The original location was recreated (a live session kept
          // writing there): keep the newer file, discard the trash copy.
          await rm(from, { recursive: true, force: true })
          this.ctx.logger.warn(`[dsh-session-manager] restore ${sessionId}: original path already exists, discarding trash copy`)
        } else {
          await mkdir(dirname(entry.originalPath), { recursive: true })
          await rename(from, entry.originalPath)
          this.ctx.logger.debug(`[dsh-session-manager] restored ${sessionId} artifact from trash`)
        }
      } else {
        this.ctx.logger.debug(`[dsh-session-manager] restore ${sessionId}: no artifact in trash (live or blank session)`)
      }

      // Only now — artifact safely back — un-archive and drop the entry.
      await unarchive(this.ctx, sessionId)
      await this.setEntries(entries.filter((candidate) => candidate.sessionId !== sessionId))
      return { ok: true }
    })
  }

  /** Permanently delete one trash entry and its artifact(s). */
  async purge(sessionId: SessionId): Promise<ActionResultResponse> {
    return this.withMutationLock(async () => {
      const entries = this.getEntries()
      const entry = entries.find((candidate) => candidate.sessionId === sessionId)
      if (entry === undefined) {
        return { ok: false, error: 'trash-entry-not-found' }
      }

      // Remove the artifact: from the trash if it was moved there, and from
      // the original location too (a live session's artifact stayed put).
      await rm(trashSessionDir(sessionId), { recursive: true, force: true })
      if (entry.originalPath !== undefined) {
        await rm(entry.originalPath, { recursive: true, force: true })
      }
      await this.setEntries(entries.filter((candidate) => candidate.sessionId !== sessionId))
      return { ok: true }
    })
  }

  /** Stop a running session's current turn. */
  async pause(sessionId: SessionId): Promise<ActionResultResponse> {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) {
      return { ok: false, error: 'agent-not-found' }
    }
    agent.cancel({ kind: 'user' })
    return { ok: true }
  }

  /** Reveal a session's log directory in the system file manager. */
  async openFolder(sessionId: SessionId): Promise<ActionResultResponse> {
    // Prefer the live artifact location; fall back to the trash entry.
    let dir: string | undefined
    const headers = await this.ctx.sessionPersistence.list()
    const meta = headers.find((header) => header.id === sessionId)
    if (meta !== undefined) {
      const location = this.ctx.sessionPersistence.locate(meta)
      if (location !== undefined) dir = dirname(location.path)
    }
    if (dir === undefined || !existsSync(dir)) {
      const entry = this.getEntries().find((candidate) => candidate.sessionId === sessionId)
      if (entry?.originalPath !== undefined && existsSync(entry.originalPath)) {
        dir = entry.originalPath
      }
    }
    if (dir === undefined || !existsSync(dir)) {
      return { ok: false, error: 'folder-not-found' }
    }
    await openFolder(dir)
    return { ok: true }
  }

  /** List the current trash contents. */
  listTrash(): TrashListResponse {
    return { ok: true, entries: this.getEntries(), limit: TRASH_LIMIT }
  }

  /**
   * Read the user-set compaction threshold. Storage is authoritative once
   * set; before the first save, fall back to the default preset file so an
   * existing value shows up.
   */
  async getThreshold(): Promise<{ ok: boolean; ratio: number }> {
    let ratio = this.configuredThreshold
    if (ratio === null) {
      try {
        const name = defaultPresetName(this.ctx)
        const preset = await resolvePresetComposition(this.ctx, name)
        const content = await readFile(preset.path, 'utf8')
        ratio = parsePresetRatio(content) ?? 0.8
      } catch {
        ratio = 0.8
      }
    }
    return { ok: true, ratio }
  }

  /**
   * Update the compaction threshold: persist it in this plugin's storage
   * domain, write it into a user preset's composition file when available
   * (system preset files are read-only), and apply it to live agents. It is
   * still enforced on EVERY session's engine at each step boundary by the
   * plugin entry's hook and survives restarts through the storage domain.
   */
  async setThreshold(ratio: number): Promise<ActionResultResponse> {
    try {
      return await this.withMutationLock(async () => {
        const current = this.trash.global.get() as TrashGlobal
        await this.trash.global.set({ ...current, thresholdRatio: ratio }).catch((error) => {
          this.ctx.logger.warn('[dsh-session-manager] threshold persist failed:', error)
          throw error
        })
        this.configuredThreshold = ratio
        const name = defaultPresetName(this.ctx)
        const preset = await resolvePresetComposition(this.ctx, name)
        if (preset.trust !== 'system') {
          await writePresetComposition(preset.path, ratio)
        }
        await applyThresholdToLiveAgents(this.ctx, ratio)
        return { ok: true }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn('[dsh-session-manager] compaction-threshold update failed:', error)
      return { ok: false, error: message }
    }
  }

  /**
   * List every persisted session as JSON rows for the TUI: header facts from
   * `sessionPersistence.list()`, the archive flag from the workspace
   * registry, the running flag from the live agent registry, and the trash
   * flag from this plugin's entries. Title and updatedAt are folded from the
   * durable transcript (the last `session/title` event and the last event
   * time); a session whose log cannot be inspected still lists, header-only.
   */
  async list(): Promise<SessionListResponse> {
    const headers = await this.ctx.sessionPersistence.list()
    const archived = new Set<string>(this.ctx.workspaceRegistry.archivedSessionIds)
    const trashed = new Set(this.getEntries().map((entry) => entry.sessionId))
    const sessions: SessionListItem[] = await Promise.all(headers.map(async (header) => {
      const agent = this.ctx.agents.get(header.id)
      let title: string | undefined
      let updatedAt = header.createdAt
      try {
        const inspection = await this.ctx.sessionPersistence.inspect(header.id)
        for (const event of inspection.events) {
          if (event.time > updatedAt) updatedAt = event.time
          if (event.type === 'session/title') title = event.data.title
        }
      } catch {
        // Unreadable or absent artifact (corrupt/torn log): header-only row.
      }
      return {
        id: header.id as string,
        title,
        cwd: header.cwd,
        createdAt: header.createdAt,
        updatedAt,
        archived: archived.has(header.id),
        running: agent?.status === 'running',
        inTrash: trashed.has(header.id),
      }
    }))
    return { ok: true, sessions }
  }

  /** Recent-activity statistics for one session, folded host-side from the
   * durable transcript (see foldSessionStats for the counting rules). */
  async stats(sessionId: SessionId): Promise<SessionStatsResponse> {
    try {
      const inspection = await this.ctx.sessionPersistence.inspect(sessionId)
      return { ok: true, stats: foldSessionStats(inspection.events) }
    } catch (error) {
      this.ctx.logger.warn(`[dsh-session-manager] stats failed for ${sessionId}:`, error)
      return { ok: false, error: 'stats-failed' }
    }
  }

  /** The current manual unread marker set. */
  getUnread(): UnreadListResponse {
    return { ok: true, ids: [...(this.trash.global.get() as TrashGlobal).unreadIds] }
  }

  /** Mark one session unread/read; emits `dsh-session-manager/unread-changed`
   * with the full new set after the durable write. */
  async setUnread(sessionId: SessionId, unread: boolean): Promise<ActionResultResponse> {
    const current = this.trash.global.get() as TrashGlobal
    const has = current.unreadIds.includes(sessionId)
    if (has === unread) return { ok: true }
    const next = unread
      ? [...current.unreadIds, sessionId]
      : current.unreadIds.filter((id) => id !== sessionId)
    await this.trash.global.set({ ...current, unreadIds: next }).catch((error) => {
      this.ctx.logger.warn('[dsh-session-manager] unread persist failed:', error)
      throw error
    })
    this.ctx.emit('dsh-session-manager/unread-changed', [...next])
    return { ok: true }
  }
}
