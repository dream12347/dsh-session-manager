/**
 * dsh-delete-session web client.
 *
 * Registers a dedicated Settings section ("会话管理" / Session Manager) via
 * the official `settings.section` slot. The panel lists every session from
 * the `useSessions` standard feed, marks the current/running ones as
 * protected, groups archived sessions at the bottom, and deletes sessions
 * through the host route (with a confirm step).
 */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, SessionSummary, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: brings the `settings.section` SlotMap declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: brings the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Button, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  DELETE_ROUTE,
  PURGE_ROUTE,
  RESTORE_ROUTE,
  TRASH_ROUTE,
  type ActionResultResponse,
  type TrashEntry,
  type TrashListResponse,
} from '../contract.ts'

export const name = 'dsh-delete-session/client'
export const inject = ['slots', 'locale']

/** Locale namespace id registered under ctx.locale. */
export const NS = 'dsh-delete-session'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The session-manager settings-section navigation label. */
    [NS]: 'nav'
  }
}

const NAV_ZH = { nav: '会话管理' } as const
const NAV_EN = { nav: 'Session Manager' } as const

const STYLE_ID = 'dsh-delete-session-style'
/** localStorage key remembering sessions the user already deleted in this browser. */
const REMOVED_KEY = 'dsh-delete-session.removed'

function loadRemoved(): Set<string> {
  try {
    const raw = window.localStorage.getItem(REMOVED_KEY)
    if (raw !== null) return new Set(JSON.parse(raw) as string[])
  } catch {
    // Storage unavailable (private mode etc.): fall back to an empty set.
  }
  return new Set()
}

function saveRemoved(removed: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(REMOVED_KEY, JSON.stringify([...removed]))
  } catch {
    // Storage unavailable: in-memory filtering still works for this session.
  }
}

const STYLE = `
[data-dsh-delete-session] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0 8px;
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-delete-session__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.dsh-delete-session__title {
  font-size: 13px;
  font-weight: 600;
}
.dsh-delete-session__count {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 12px;
}
.dsh-delete-session__notice {
  border-radius: 8px;
  font-size: 12px;
  padding: 6px 10px;
  line-height: 1.5;
}
.dsh-delete-session__notice--ok {
  background: rgba(34, 197, 94, .12);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-delete-session__notice--error {
  background: rgba(239, 68, 68, .12);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-delete-session__empty {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 12px;
  padding: 4px 0;
}
.dsh-delete-session__group {
  border-top: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .14));
  margin-top: 10px;
  padding-top: 8px;
}
.dsh-delete-session__group-toggle {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  display: flex;
  font: inherit;
  font-size: 12px;
  gap: 8px;
  justify-content: space-between;
  padding: 6px 8px;
  width: 100%;
}
.dsh-delete-session__group-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .08));
}
.dsh-delete-session__group-toggle-label {
  font-weight: 600;
}
.dsh-delete-session__group-toggle-chevron {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}
.dsh-delete-session__group-hint {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 11px;
  line-height: 1.5;
  margin: 6px 8px 0;
}
.dsh-delete-session__row[data-archived] {
  opacity: .72;
}
.dsh-delete-session__row[data-trash] {
  opacity: .85;
}
.dsh-delete-session__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-delete-session__row {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .18));
  border-radius: 10px;
  padding: 8px 10px;
}
.dsh-delete-session__row-main {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-delete-session__row-title {
  font-size: 13px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-delete-session__row-meta {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 11px;
  line-height: 1.4;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-delete-session__row[data-current] .dsh-delete-session__row-title::after {
  content: " · " attr(data-current-label);
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-weight: 400;
}
`

interface SessionManagerProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<import('@deepseek-ai/dsh-client-runtime/client').WorkspaceListState>
}

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

function isZh(): boolean {
  return typeof document !== 'undefined' && document.documentElement.lang.toLowerCase().startsWith('zh')
}

function stringsOf() {
  return isZh()
    ? {
        title: '会话管理',
        count: (used: number) => `${used} 个会话`,
        current: '当前会话',
        delete: '删除',
        deleting: '删除中…',
        confirm: '确定删除会话「{title}」吗？它会移入回收站，可在「回收站」中恢复或彻底删除。',
        deleted: '已删除会话「{title}」',
        failed: '删除会话「{title}」失败',
        liveError: '（会话正在使用中，请先停止后再删）',
        notFoundError: '（会话不存在或已被删除）',
        running: '运行中',
        archived: '已归档',
        archivedGroup: '已归档会话',
        archivedHint: '已归档会话删除后移入回收站；这里只是归档状态（侧边栏隐藏）。',
        trashGroup: '回收站',
        trashHint: '保留最近 {limit} 条已删除会话，超出后最早的一条会被自动彻底删除。',
        trashEmpty: '回收站为空。',
        trashLoadFailed: '回收站加载失败',
        restore: '恢复',
        restoreConfirm: '确定恢复会话「{title}」吗？它会回到会话列表。',
        restored: '已恢复会话「{title}」',
        restoreFailed: '恢复会话「{title}」失败',
        purge: '彻底删除',
        purgeConfirm: '确定彻底删除会话「{title}」吗？日志与记录将永久清除，无法恢复。',
        purged: '已彻底删除会话「{title}」',
        purgeFailed: '彻底删除会话「{title}」失败',
        expand: '展开',
        collapse: '收起',
        empty: '没有可管理的会话。',
        noCwd: '(未知工作目录)',
        deletedAt: (ms: number) => {
          const d = new Date(ms)
          const pad = (n: number) => String(n).padStart(2, '0')
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        },
      }
    : {
        title: 'Session Manager',
        count: (used: number) => `${used} sessions`,
        current: 'current session',
        delete: 'Delete',
        deleting: 'Deleting…',
        confirm: 'Delete session "{title}"? It moves to the trash, where you can restore or permanently delete it.',
        deleted: 'Deleted session "{title}"',
        failed: 'Failed to delete session "{title}"',
        liveError: ' (session is in use; stop it before deleting)',
        notFoundError: ' (session does not exist or was already deleted)',
        running: 'running',
        archived: 'archived',
        archivedGroup: 'Archived sessions',
        archivedHint: 'Deleting an archived session moves it to the trash; this list is just the archived (sidebar-hidden) state.',
        trashGroup: 'Trash',
        trashHint: 'Keeps the most recent {limit} deleted sessions; the oldest one is purged automatically when the limit is exceeded.',
        trashEmpty: 'The trash is empty.',
        trashLoadFailed: 'Failed to load the trash',
        restore: 'Restore',
        restoreConfirm: 'Restore session "{title}"? It will return to the session list.',
        restored: 'Restored session "{title}"',
        restoreFailed: 'Failed to restore session "{title}"',
        purge: 'Delete permanently',
        purgeConfirm: 'Permanently delete session "{title}"? Its logs and records cannot be recovered.',
        purged: 'Permanently deleted session "{title}"',
        purgeFailed: 'Failed to permanently delete session "{title}"',
        expand: 'Expand',
        collapse: 'Collapse',
        empty: 'No manageable sessions.',
        noCwd: '(unknown working directory)',
        deletedAt: (ms: number) => {
          const d = new Date(ms)
          const pad = (n: number) => String(n).padStart(2, '0')
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        },
      }
}

function SessionManager({ useSessions, useWorkspaces }: SessionManagerProps): ReactElement {
  const list = useSessions((state) => state)
  const workspaces = useWorkspaces((state) => state)
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => loadRemoved())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [trashLimit, setTrashLimit] = useState(10)
  const [trashFailed, setTrashFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const strings = stringsOf()

  // Notices auto-dismiss after a few seconds instead of lingering.
  const showNotice = useCallback((next: Notice): void => {
    setNotice(next)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  const loadTrash = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(TRASH_ROUTE)
      const data = (await response.json().catch(() => ({}))) as TrashListResponse
      if (response.ok && data.ok) {
        setTrash(data.entries)
        setTrashLimit(data.limit)
        setTrashFailed(false)
      } else {
        setTrashFailed(true)
      }
    } catch {
      setTrashFailed(true)
    }
  }, [])
  useEffect(() => {
    void loadTrash()
  }, [loadTrash])

  const archivedSet = new Set(workspaces.archivedSessionIds)
  const trashIds = new Set((trash ?? []).map((entry) => entry.sessionId))
  const summaries: SessionSummary[] = list.ids
    .map((id) => list.byId[id])
    .filter((session): session is SessionSummary => session !== undefined && !removed.has(session.id))
  const activeRows = summaries.filter((session) => !archivedSet.has(session.id))
  const archivedRows = summaries.filter((session) => archivedSet.has(session.id) && !trashIds.has(session.id))

  const markRemoved = useCallback((sessionId: string): void => {
    setRemoved((previous) => {
      const next = new Set(previous)
      next.add(sessionId)
      saveRemoved(next)
      return next
    })
  }, [])

  const handleDelete = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.confirm.replace('{title}', title))) return
    setBusyId(sessionId)
    setNotice(null)
    try {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = (await response.json().catch(() => ({}))) as ActionResultResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      await loadTrash()
      showNotice({ kind: 'ok', text: strings.deleted.replace('{title}', title) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const friendly = code === 'session-live' ? strings.liveError : code === 'session-not-found' ? strings.notFoundError : ''
      const suffix = friendly !== '' ? friendly : code !== '' ? ` (${code})` : ''
      showNotice({ kind: 'error', text: strings.failed.replace('{title}', title) + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, loadTrash, showNotice])

  const handleRestore = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.restoreConfirm.replace('{title}', title))) return
    setBusyId(sessionId)
    setNotice(null)
    try {
      const response = await fetch(RESTORE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = (await response.json().catch(() => ({}))) as ActionResultResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      await loadTrash()
      showNotice({ kind: 'ok', text: strings.restored.replace('{title}', title) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const suffix = code !== '' ? ` (${code})` : ''
      showNotice({ kind: 'error', text: strings.restoreFailed.replace('{title}', title) + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, loadTrash, showNotice])

  const handlePurge = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.purgeConfirm.replace('{title}', title))) return
    setBusyId(sessionId)
    setNotice(null)
    try {
      const response = await fetch(PURGE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = (await response.json().catch(() => ({}))) as ActionResultResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      markRemoved(sessionId)
      await loadTrash()
      showNotice({ kind: 'ok', text: strings.purged.replace('{title}', title) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const suffix = code !== '' ? ` (${code})` : ''
      showNotice({ kind: 'error', text: strings.purgeFailed.replace('{title}', title) + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, loadTrash, markRemoved, showNotice])

  const renderRow = (session: SessionSummary, isArchived: boolean): ReactElement => {
    const isCurrent = !isArchived && session.id === list.current
    const isSubagent = session.origin === 'subagent'
    const isRunning = session.running
    const busy = busyId === session.id
    const protectedReason = isCurrent ? strings.current : isSubagent ? 'subagent' : isRunning ? strings.running : ''
    const metaParts = [session.cwd ?? strings.noCwd]
    if (isArchived) metaParts.push(strings.archived)
    if (protectedReason !== '' && !isCurrent) metaParts.push(protectedReason)
    return createElement('li', {
      key: session.id,
      className: 'dsh-delete-session__row',
      'data-current': isCurrent || undefined,
      'data-current-label': strings.current,
      'data-archived': isArchived || undefined,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title' }, session.displayTitle),
        createElement('div', { className: 'dsh-delete-session__row-meta' }, metaParts.join(' · ')),
      ),
      createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconTrashOutline16, { size: 16 }),
        disabled: isCurrent || isSubagent || isRunning || busy,
        title: protectedReason !== '' && !isCurrent ? protectedReason : strings.delete,
        onClick: () => void handleDelete(session.id, session.displayTitle),
        children: busy ? strings.deleting : strings.delete,
      }),
    )
  }

  const renderTrashRow = (entry: TrashEntry): ReactElement => {
    const title = list.byId[entry.sessionId as SessionId]?.displayTitle ?? entry.sessionId
    const busy = busyId === entry.sessionId
    return createElement('li', {
      key: entry.sessionId,
      className: 'dsh-delete-session__row',
      'data-trash': true,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title' }, title),
        createElement('div', { className: 'dsh-delete-session__row-meta' },
          [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(' · '),
        ),
      ),
      createElement(Button, {
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handleRestore(entry.sessionId, title),
        children: strings.restore,
      }),
      createElement(Button, {
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconTrashOutline16, { size: 16 }),
        disabled: busy,
        onClick: () => void handlePurge(entry.sessionId, title),
        children: strings.purge,
      }),
    )
  }

  return createElement('div', { 'data-dsh-delete-session': '' },
    createElement('div', { className: 'dsh-delete-session__header' },
      createElement('span', { className: 'dsh-delete-session__title' }, strings.title),
      createElement('span', { className: 'dsh-delete-session__count' }, strings.count(activeRows.length)),
    ),
    notice !== null && createElement('div', {
      className: `dsh-delete-session__notice dsh-delete-session__notice--${notice.kind}`,
    }, notice.text),
    activeRows.length === 0
      ? createElement('div', { className: 'dsh-delete-session__empty' }, strings.empty)
      : createElement('ul', { className: 'dsh-delete-session__list' },
          ...activeRows.map((session) => renderRow(session, false)),
        ),
    archivedRows.length > 0 && createElement('div', { className: 'dsh-delete-session__group' },
      createElement('button', {
        type: 'button',
        className: 'dsh-delete-session__group-toggle',
        onClick: () => setArchivedOpen((open) => !open),
        'aria-expanded': archivedOpen || undefined,
      },
        createElement('span', { className: 'dsh-delete-session__group-toggle-label' },
          `${strings.archivedGroup} (${archivedRows.length})`,
        ),
        createElement('span', { className: 'dsh-delete-session__group-toggle-chevron' },
          archivedOpen ? strings.collapse : strings.expand,
        ),
      ),
      archivedOpen && createElement('ul', { className: 'dsh-delete-session__list' },
        ...archivedRows.map((session) => renderRow(session, true)),
      ),
      createElement('div', { className: 'dsh-delete-session__group-hint' }, strings.archivedHint),
    ),
    trash !== null && createElement('div', { className: 'dsh-delete-session__group' },
      createElement('button', {
        type: 'button',
        className: 'dsh-delete-session__group-toggle',
        onClick: () => setTrashOpen((open) => !open),
        'aria-expanded': trashOpen || undefined,
      },
        createElement('span', { className: 'dsh-delete-session__group-toggle-label' },
          `${strings.trashGroup} (${trash.length}/${trashLimit})`,
        ),
        createElement('span', { className: 'dsh-delete-session__group-toggle-chevron' },
          trashOpen ? strings.collapse : strings.expand,
        ),
      ),
      trashFailed
        ? createElement('div', { className: 'dsh-delete-session__group-hint' }, strings.trashLoadFailed)
        : trashOpen && (trash.length === 0
            ? createElement('div', { className: 'dsh-delete-session__empty' }, strings.trashEmpty)
            : createElement('ul', { className: 'dsh-delete-session__list' },
                ...trash.map((entry) => renderTrashRow(entry)),
              )),
      createElement('div', { className: 'dsh-delete-session__group-hint' },
        strings.trashHint.replace('{limit}', String(trashLimit)),
      ),
    ),
  )
}

export function apply(ctx: ClientContext): void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE
  document.head.append(style)

  // Locale dictionaries: the settings-section navigation label.
  ctx.effect(() => ctx.locale.register(NS, { zh: NAV_ZH, en: NAV_EN }), 'dsh-delete-session: dictionaries')
  const t = ctx.locale.bind(NS)

  // A dedicated Settings section (like Notifications), not a General row.
  ctx.slots.inject('settings.section', () => {
    const disposeRegistration = ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-delete-session',
      order: 60,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({}),
    }, SessionManager)
    return () => {
      disposeRegistration()
      style.remove()
    }
  })
}

interface ClientContext {
  slots: SlotRegistry
  effect(effect: () => void | (() => void), label?: string): void
  locale: {
    register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(namespace: string): (key: 'nav') => string
  }
}
