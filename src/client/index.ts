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
// Type-only: brings the `settings.section` SlotMap declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: brings the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Button, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, useCallback, useState, type ReactElement } from 'react'
import { DELETE_ROUTE, type DeleteSessionResponse } from '../contract.ts'

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
        count: (used: number, total: number) => `${used} / ${total} 个会话`,
        current: '当前会话',
        delete: '删除',
        deleting: '删除中…',
        confirm: '确定删除会话「{title}」吗？日志与记录将被永久清除，无法恢复。',
        deleted: '已删除会话「{title}」',
        failed: '删除会话「{title}」失败',
        liveError: '（会话正在使用中，请先停止后再删）',
        notFoundError: '（会话不存在或已被删除）',
        running: '运行中',
        archived: '已归档',
        archivedGroup: '已归档会话',
        archivedHint: '已归档会话删除后彻底清除；列表记录将在重启 DSH 后自动清理。',
        expand: '展开',
        collapse: '收起',
        empty: '没有可管理的会话。',
        noCwd: '(未知工作目录)',
      }
    : {
        title: 'Session Manager',
        count: (used: number, total: number) => `${used} / ${total} sessions`,
        current: 'current session',
        delete: 'Delete',
        deleting: 'Deleting…',
        confirm: 'Delete session "{title}"? Its logs and records will be permanently removed. This cannot be undone.',
        deleted: 'Deleted session "{title}"',
        failed: 'Failed to delete session "{title}"',
        liveError: ' (session is in use; stop it before deleting)',
        notFoundError: ' (session does not exist or was already deleted)',
        running: 'running',
        archived: 'archived',
        archivedGroup: 'Archived sessions',
        archivedHint: 'Deleting an archived session removes it permanently; leftover records are cleaned up on the next DSH restart.',
        expand: 'Expand',
        collapse: 'Collapse',
        empty: 'No manageable sessions.',
        noCwd: '(unknown working directory)',
      }
}

function SessionManager({ useSessions, useWorkspaces }: SessionManagerProps): ReactElement {
  const list = useSessions((state) => state)
  const workspaces = useWorkspaces((state) => state)
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => loadRemoved())
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const strings = stringsOf()

  const archivedSet = new Set(workspaces.archivedSessionIds)
  const summaries: SessionSummary[] = list.ids
    .map((id) => list.byId[id])
    .filter((session): session is SessionSummary => session !== undefined && !removed.has(session.id))
  const activeRows = summaries.filter((session) => !archivedSet.has(session.id))
  const archivedRows = summaries.filter((session) => archivedSet.has(session.id))

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
      const data = (await response.json().catch(() => ({}))) as DeleteSessionResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      markRemoved(sessionId)
      setNotice({ kind: 'ok', text: strings.deleted.replace('{title}', title) })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const friendly = code === 'session-live' ? strings.liveError : code === 'session-not-found' ? strings.notFoundError : ''
      const suffix = friendly !== '' ? friendly : code !== '' ? ` (${code})` : ''
      setNotice({ kind: 'error', text: strings.failed.replace('{title}', title) + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, markRemoved])

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

  return createElement('div', { 'data-dsh-delete-session': '' },
    createElement('div', { className: 'dsh-delete-session__header' },
      createElement('span', { className: 'dsh-delete-session__title' }, strings.title),
      createElement('span', { className: 'dsh-delete-session__count' }, strings.count(activeRows.length, list.ids.length)),
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
