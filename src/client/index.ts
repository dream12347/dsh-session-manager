/**
 * dsh-delete-session web client.
 *
 * Registers a dedicated Settings section ("会话管理" / Session Manager) via
 * the official `settings.section` slot. The panel lists every session from
 * the `useSessions` standard feed, marks the current/running ones as
 * protected, groups archived sessions at the bottom, and deletes sessions
 * through the host route (with a confirm step). Each row can also fold a
 * recent-activity stats (via the official `session.history` RPC) and reveal
 * the session's log directory in the system file manager.
 */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, SessionSummary, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: brings the `settings.section` SlotMap declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: brings the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: brings the conversation header slots' SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: merges the 'title' projection key the wire session summaries read.
import type {} from '@deepseek-ai/dsh-session-title/client'
// Type-only: brings the connection/remote merges and IApiClient types.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle, HistoryEntry, SessionId as WireSessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  DELETE_ROUTE,
  OPEN_FOLDER_ROUTE,
  PAUSE_ROUTE,
  PURGE_ROUTE,
  RESTORE_ROUTE,
  TRASH_ROUTE,
  type ActionResultResponse,
  type TrashEntry,
  type TrashListResponse,
} from '../contract.ts'

export const name = 'dsh-delete-session/client'
export const inject = ['slots', 'locale', 'connection', 'sessions', 'workspaces']

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
/** localStorage key remembering session titles at delete time, so the trash
 * can still show a name once the artifact (and the list row) is gone. */
const TITLES_KEY = 'dsh-delete-session.titles'

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

function loadTitles(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(TITLES_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Record<string, string>
      if (typeof parsed === 'object' && parsed !== null) return parsed
    }
  } catch {
    // Storage unavailable: fall back to empty titles.
  }
  return {}
}

function saveTitle(sessionId: string, title: string): void {
  try {
    const next = { ...loadTitles(), [sessionId]: title }
    window.localStorage.setItem(TITLES_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: title display degrades to the session id.
  }
}

/** Resolve a trash entry's display title: live row, remembered title, id. */
function trashEntryTitle(
  titles: Record<string, string>,
  entry: TrashEntry,
  liveTitle: string | undefined,
): string {
  return liveTitle ?? titles[entry.sessionId] ?? entry.sessionId
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
.dsh-delete-session__sort {
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  margin-left: auto;
  padding: 2px 8px;
}
.dsh-delete-session__sort:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1));
  color: var(--dsw-alias-label-primary, #111827);
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
.dsh-delete-session__group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12px;
  font-weight: 650;
  margin: 10px 0 4px;
  padding: 0 2px;
}
.dsh-delete-session__group-label-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-delete-session__group-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity .15s;
}
.dsh-delete-session__group-label:hover .dsh-delete-session__group-actions,
.dsh-delete-session__group-actions:focus-within {
  opacity: 1;
}
.dsh-delete-session__group-action {
  flex: none;
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border: 1px solid var(--dsw-alias-border-default, #e5e7eb);
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  white-space: nowrap;
}
.dsh-delete-session__group-action:hover {
  border-color: var(--dsw-alias-state-info-border, #4d6bfe);
  color: var(--dsw-alias-state-info-border, #4d6bfe);
}
.dsh-delete-session__group-action--danger,
.dsh-delete-session__group-action--danger:hover {
  border-color: var(--dsw-alias-state-danger-border, #ef4444);
  color: var(--dsw-alias-state-danger-border, #ef4444);
}
.dsh-delete-session__group-label:first-child {
  margin-top: 0;
}
.dsh-delete-session__group-label--drag {
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.dsh-delete-session__group-label--drag[data-dragging] {
  opacity: .5;
}
.dsh-delete-session__group-label--drag[data-drop-swap] {
  background: var(--dsw-alias-state-info-bg, rgba(77, 107, 254, .14));
  border-radius: 6px;
}
/* Thin insertion lines hugging the group edges: "after A" and "before B"
   draw the SAME line on B's top edge. The first group has no top border. */
.dsh-delete-session__group[data-line-top] {
  box-shadow: 0 -2px 0 var(--dsw-alias-state-info-border, #4d6bfe);
}
.dsh-delete-session__group[data-line-end] {
  box-shadow: 0 2px 0 var(--dsw-alias-state-info-border, #4d6bfe);
}
.dsh-delete-session__group[data-first] {
  border-top: 0;
  margin-top: 0;
  padding-top: 0;
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
/* Row action buttons must never wrap (a narrow row would stack the label
   vertically, e.g. 继续/会话) nor shrink below their content. */
.dsh-delete-session__row .dsh-row-action {
  flex: none;
  white-space: nowrap;
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
.dsh-delete-session__stats {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .06));
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  margin-top: 6px;
  padding: 6px 10px;
}
.dsh-delete-session__stats-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-delete-current] {
  align-items: center;
  appearance: none;
  background: rgba(239, 68, 68, .1);
  border: 0;
  border-radius: 8px;
  color: rgb(220, 38, 38);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  gap: 4px;
  height: 28px;
  justify-content: center;
  padding: 0 10px;
  white-space: nowrap;
}
[data-dsh-delete-current]:hover {
  background: rgba(239, 68, 68, .2);
}
[data-dsh-delete-current]:disabled {
  cursor: not-allowed;
  opacity: .5;
}
[data-dsh-header-button] {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .28));
  border-radius: 8px;
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  display: inline-flex;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  gap: 4px;
  height: 28px;
  justify-content: center;
  padding: 0 10px;
  white-space: nowrap;
}
[data-dsh-header-button]:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1));
}
[data-dsh-header-trash] {
  color: var(--dsw-alias-label-secondary, #6b7280);
}
[data-dsh-drawer-backdrop] {
  background: rgba(0, 0, 0, .28);
  inset: 0;
  position: fixed;
  z-index: 1200;
}
[data-dsh-drawer] {
  background: var(--dsw-alias-bg-base, #fff);
  border-left: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .18));
  bottom: 0;
  box-shadow: -16px 0 40px rgba(0, 0, 0, .18);
  display: flex;
  flex-direction: column;
  position: fixed;
  right: 0;
  top: 0;
  width: 400px;
  z-index: 1201;
}
.dsh-drawer__header {
  align-items: center;
  border-bottom: 1px solid var(--dsw-alias-line-border, rgba(127, 127, 127, .14));
  display: flex;
  flex: none;
  gap: 6px;
  padding: 12px 14px;
}
.dsh-drawer__title {
  flex: 1 1 auto;
  font-size: 14px;
  font-weight: 650;
  min-width: 0;
}
.dsh-drawer__pin {
  align-items: center;
  appearance: none;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  cursor: pointer;
  display: inline-flex;
  height: 26px;
  justify-content: center;
  padding: 0;
  width: 26px;
}
.dsh-drawer__pin:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .1));
}
.dsh-drawer__pin[data-pinned] {
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-drawer__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.dsh-drawer__hint {
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  font-size: 11px;
  line-height: 1.5;
  margin-bottom: 8px;
}
`

interface SessionManagerProps {
  useSessions: SnapshotSelectorHook<SessionListState>
  useWorkspaces: SnapshotSelectorHook<import('@deepseek-ai/dsh-client-runtime/client').WorkspaceListState>
  /** Wire client for the official session.history RPC (stats folding). */
  api: Pick<import('@deepseek-ai/dsh-api-remotes/client').IApiClient, 'sessions'>
  /** Browser sessions service: open a session and close the settings panel. */
  sessions: import('@deepseek-ai/dsh-client-runtime/client').ISessions
  /** Workspaces service: durable workspace reordering (drag & drop). */
  workspaceActions: import('@deepseek-ai/dsh-client-runtime/client').IWorkspaces
  /** Close the settings panel (settings.section owner seat). */
  close: () => void
}

interface Notice {
  kind: 'ok' | 'error'
  text: string
}

/** Folded conversation statistics for one session's recent window. */
interface SessionStats {
  turns: number
  userMessages: number
  assistantMessages: number
  toolCalls: { name: string; count: number }[]
  startedAt: number
  updatedAt: number
}

/**
 * Fold a history window into an stats. The tail page carries at most
 * `maxMessages` messages, so a long session's stats reflects its recent
 * window; `startedAt`/`updatedAt` are the window's own bounds. Events the
 * fold does not recognize are skipped.
 */
function foldStats(entries: readonly HistoryEntry[]): SessionStats {
  let turns = 0
  let userMessages = 0
  let assistantMessages = 0
  const toolCounts = new Map<string, number>()
  let startedAt = Number.POSITIVE_INFINITY
  let updatedAt = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    const { type, time, data } = entry.event
    if (time < startedAt) startedAt = time
    if (time > updatedAt) updatedAt = time
    if (type === 'turn/start') turns += 1
    else if (type === 'user/message') userMessages += 1
    else if (type === 'assistant/message') assistantMessages += 1
    else if (type === 'tool/call') {
      toolCounts.set(data.name, (toolCounts.get(data.name) ?? 0) + 1)
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

/** One session's stats state: loading, ready, or failed. */
interface StatsState {
  status: 'loading' | 'ready' | 'error'
  data: SessionStats | null
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
        continue: '继续会话',
        pause: '暂停',
        paused: '已暂停会话',
        pauseFailed: '暂停失败',
        stats: '统计',
        statsLoading: '统计加载中…',
        statsFailed: '统计加载失败',
        statsEmpty: '（近期窗口内没有活动）',
        statsTurns: '轮次',
        statsUser: '用户消息',
        statsAssistant: '助手消息',
        statsTools: '工具调用',
        statsWindow: '活动窗口',
        folder: '文件夹',
        folderOpen: '已在文件管理器中打开',
        folderFailed: '打开文件夹失败',
        deleteCurrent: '删除本对话',
        deleteCurrentConfirm: '确定删除当前对话吗？将移入回收站，可在「会话管理」中恢复或彻底删除。',
        deleteCurrentFailed: '删除当前对话失败',
        deleteCurrentRunning: '对话正在运行',
        manageButton: '对话管理',
        trashButton: '回收站',
        pin: '固定面板',
        unpin: '取消固定',
        drawerPinHint: '固定后面板保持打开，点击面板外不会自动收起。',
        close: '关闭',
        ungrouped: '未分组',
        sortNewest: '最新在前',
        sortOldest: '最旧在前',
        workspaceDragHint: '拖动调整工作区顺序',
        workspaceToTop: '置于顶部',
        workspaceRename: '重命名',
        workspaceRenamePrompt: '请输入工作区「{title}」的新名称：',
        workspaceDelete: '删除',
        workspaceDeleteConfirm: '将把「{title}」从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在「未分组」下。',
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
        continue: 'Continue session',
        pause: 'Pause',
        paused: 'Session paused',
        pauseFailed: 'Failed to pause',
        stats: 'Stats',
        statsLoading: 'Loading stats…',
        statsFailed: 'Failed to load stats',
        statsEmpty: '(no activity in the recent window)',
        statsTurns: 'turns',
        statsUser: 'user messages',
        statsAssistant: 'assistant messages',
        statsTools: 'tool calls',
        statsWindow: 'activity window',
        folder: 'Folder',
        folderOpen: 'Opened in the file manager',
        folderFailed: 'Failed to open folder',
        deleteCurrent: 'Delete this session',
        deleteCurrentConfirm: 'Delete this conversation? It moves to the trash, where you can restore or permanently delete it.',
        deleteCurrentFailed: 'Failed to delete this session',
        deleteCurrentRunning: 'the conversation is running',
        manageButton: 'Session Manager',
        trashButton: 'Trash',
        pin: 'Pin panel',
        unpin: 'Unpin panel',
        drawerPinHint: 'When pinned, the panel stays open and does not close on outside clicks.',
        close: 'Close',
        ungrouped: 'Ungrouped',
        sortNewest: 'Newest first',
        sortOldest: 'Oldest first',
        workspaceDragHint: 'Drag to reorder workspaces',
        workspaceToTop: 'Move to top',
        workspaceRename: 'Rename',
        workspaceRenamePrompt: 'Enter a new name for workspace "{title}":',
        workspaceDelete: 'Delete',
        workspaceDeleteConfirm: 'This removes "{title}" from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.',
        deletedAt: (ms: number) => {
          const d = new Date(ms)
          const pad = (n: number) => String(n).padStart(2, '0')
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        },
      }
}

function SessionManager({ useSessions, useWorkspaces, api, sessions, workspaceActions, close }: SessionManagerProps): ReactElement {
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
  const [statsId, setStatsId] = useState<string | null>(null)
  const [stats, setStats] = useState<StatsState | null>(null)
  const [newestFirst, setNewestFirst] = useState(true)
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null)
  // Drop slot: 'before:<id>' inserts before that workspace, 'end' appends.
  const [dropSlot, setDropSlot] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  // Mutable mirrors for pointer-drag handlers (avoid stale closures).
  const dropSlotRef = useRef<string | null>(null)
  const groupsRef = useRef<typeof activeGroups>([])
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
  // Blank sessions (created, never messaged) are hidden, mirroring the
  // official sidebar — they have no content to manage and no title to show.
  const summaries: SessionSummary[] = list.ids
    .map((id) => list.byId[id])
    .filter((session): session is SessionSummary =>
      session !== undefined && !removed.has(session.id) && !session.blank)
  const activeRows = summaries.filter((session) => !archivedSet.has(session.id))
  const archivedRows = summaries.filter((session) => archivedSet.has(session.id) && !trashIds.has(session.id))

  // Group active sessions by workspace; within each group sort by last use
  // (updatedAt), newest first by default, toggled by the header sort button.
  const sortActive = (rows: SessionSummary[]): SessionSummary[] =>
    [...rows].sort((a, b) => (newestFirst ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt))
  const activeGroups: { workspaceId: string; title: string; rows: SessionSummary[] }[] = []
  for (const view of workspaces.items) {
    const rows = sortActive(activeRows.filter((session) => view.sessionIds.includes(session.id)))
    if (rows.length > 0) activeGroups.push({ workspaceId: view.workspaceId, title: view.title || view.path, rows })
  }
  const ungroupedActive = sortActive(activeRows.filter((session) =>
    !workspaces.items.some((view) => view.sessionIds.includes(session.id))))
  if (ungroupedActive.length > 0) activeGroups.push({ workspaceId: '__ungrouped__', title: strings.ungrouped, rows: ungroupedActive })
  groupsRef.current = activeGroups

  // Custom pointer-based drag & drop (HTML5 DnD drops were unreliable here).
  // The judge zone is the LABEL itself: its upper half inserts before the
  // workspace, its lower half after it. "After A" and "before B" normalize to
  // the same slot (B's top edge), so one thin line is drawn.
  const handleWorkspaceDrop = useCallback(async (slot: string | null): Promise<void> => {
    setDropSlot(null)
    const dragged = dragWorkspaceId
    setDragWorkspaceId(null)
    if (dragged === null || slot === null) return
    try {
      let beforeId: string | undefined
      if (slot.startsWith('swap:')) {
        // Swap with the target workspace.
        const swapId = slot.slice(5)
        if (swapId === dragged || swapId === '__ungrouped__') return
        const order = groupsRef.current.map((g) => g.workspaceId)
        const aIndex = order.indexOf(dragged)
        const bIndex = order.indexOf(swapId)
        beforeId = aIndex >= 0 && bIndex >= 0 && aIndex < bIndex ? order[bIndex + 1] : swapId
      } else if (slot.startsWith('before:')) {
        beforeId = slot.slice(7)
      }
      // '__end__' leaves beforeId undefined → appended to the very end.
      await workspaceActions.insertBefore(dragged as never, beforeId as never)
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [workspaceActions, dragWorkspaceId])

  // Move a workspace to the top of the group list.
  const moveWorkspaceToTop = useCallback(async (workspaceId: string): Promise<void> => {
    const order = groupsRef.current.map((g) => g.workspaceId)
    const firstId = order.find((id) => id !== '__ungrouped__')
    if (firstId === undefined || firstId === workspaceId) return
    try {
      await workspaceActions.insertBefore(workspaceId as never, firstId as never)
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [workspaceActions])

  // Rename a workspace through a prompt dialog.
  const renameWorkspace = useCallback(async (group: { workspaceId: string; title: string }): Promise<void> => {
    const input = window.prompt(strings.workspaceRenamePrompt.replace('{title}', group.title), group.title)
    if (input === null) return
    const title = input.trim()
    if (title === '' || title === group.title) return
    try {
      await workspaceActions.rename(group.workspaceId as never, title as never)
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [workspaceActions])

  // Delete a workspace after a confirmation dialog; its sessions fall back
  // to the ungrouped bucket.
  const deleteWorkspace = useCallback(async (group: { workspaceId: string; title: string }): Promise<void> => {
    if (!window.confirm(strings.workspaceDeleteConfirm.replace('{title}', group.title))) return
    try {
      await workspaceActions.delete(group.workspaceId as never)
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [workspaceActions])

  const renderWorkspaceLabel = (
    group: { workspaceId: string; title: string; rows: SessionSummary[] },
    index: number,
  ): ReactElement => {
    const draggable = group.workspaceId !== '__ungrouped__'
    return createElement('div', {
      className: 'dsh-delete-session__group-label' + (draggable ? ' dsh-delete-session__group-label--drag' : ''),
      'data-drag-workspace': group.workspaceId,
      'data-dragging': dragWorkspaceId === group.workspaceId || undefined,
      'data-drop-swap': dropSlot === `swap:${group.workspaceId}` || undefined,
      title: draggable ? strings.workspaceDragHint : undefined,
      onPointerDown: draggable ? (e: PointerEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        setDragWorkspaceId(group.workspaceId)
        dropSlotRef.current = null
        setDropSlot(null)
        const el = e.currentTarget as HTMLElement
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Capture is best-effort; moves still arrive while over the element.
        }
      } : undefined,
      onPointerMove: draggable ? (e: PointerEvent) => {
        if (dragWorkspaceId === null) return
        // Fuzzy judge: map the pointer Y to the nearest workspace label inside
        // this panel. Anywhere below a label (its sessions, the gap) counts as
        // that label's "after"; the upper half of the label itself is "before".
        const hit = document.elementFromPoint(e.clientX, e.clientY)
        const panel = hit instanceof Element
          ? hit.closest('[data-dsh-delete-session], [data-dsh-drawer]')
          : null
        if (panel === null) {
          dropSlotRef.current = null
          setDropSlot(null)
          return
        }
        const labels = Array.from(panel.querySelectorAll('[data-drag-workspace]'))
        const groups = groupsRef.current
        let targetIndex = -1
        for (let i = 0; i < labels.length; i++) {
          const rect = labels[i].getBoundingClientRect()
          if (e.clientY >= rect.top - 6) targetIndex = i
        }
        if (targetIndex < 0 || targetIndex >= groups.length) {
          dropSlotRef.current = null
          setDropSlot(null)
          return
        }
        const rect = labels[targetIndex].getBoundingClientRect()
        let slot: string | null
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // On the label itself: swap the two workspaces.
          slot = `swap:${groups[targetIndex].workspaceId}`
        } else if (e.clientY < rect.top) {
          slot = `before:${groups[targetIndex].workspaceId}`
        } else {
          const next = targetIndex + 1 < groups.length ? groups[targetIndex + 1] : null
          slot = next !== null ? `before:${next.workspaceId}` : '__end__'
        }
        dropSlotRef.current = slot
        setDropSlot(slot)
      } : undefined,
      onPointerUp: draggable ? (e: PointerEvent) => {
        if (dragWorkspaceId === null) return
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          // Noop when capture was never granted.
        }
        void handleWorkspaceDrop(dropSlotRef.current)
      } : undefined,
      children: [
        createElement('span', { className: 'dsh-delete-session__group-label-text' }, `${group.title} (${group.rows.length})`),
        draggable ? createElement('span', { className: 'dsh-delete-session__group-actions' },
          createElement('button', {
            className: 'dsh-delete-session__group-action',
            type: 'button',
            title: strings.workspaceToTop,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void moveWorkspaceToTop(group.workspaceId)
            },
          }, strings.workspaceToTop),
          createElement('button', {
            className: 'dsh-delete-session__group-action',
            type: 'button',
            title: strings.workspaceRename,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void renameWorkspace(group)
            },
          }, strings.workspaceRename),
          createElement('button', {
            className: 'dsh-delete-session__group-action dsh-delete-session__group-action--danger',
            type: 'button',
            title: strings.workspaceDelete,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void deleteWorkspace(group)
            },
          }, strings.workspaceDelete),
        ) : null,
      ],
    })
  }

  // The group block is pure presentation; the thin line hugs the group edge.
  const renderWorkspaceGroup = (group: { workspaceId: string; title: string; rows: SessionSummary[] }, index: number): ReactElement => {
    const next = index + 1 < activeGroups.length ? activeGroups[index + 1] : null
    return createElement('div', {
      key: group.workspaceId,
      className: 'dsh-delete-session__group',
      'data-first': index === 0 || undefined,
      'data-line-top': dropSlot === `before:${group.workspaceId}` || undefined,
      'data-line-end': dropSlot === '__end__' && next === null || undefined,
    },
      renderWorkspaceLabel(group, index),
      createElement('ul', { className: 'dsh-delete-session__list' },
        ...group.rows.map((session) => renderRow(session, false)),
      ),
    )
  }

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
    saveTitle(sessionId, title)
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

  // Toggle the stats for one session: fold the recent history window.
  const handleStats = useCallback(async (sessionId: string): Promise<void> => {
    if (statsId === sessionId) {
      setStatsId(null)
      setStats(null)
      return
    }
    setStatsId(sessionId)
    setStats({ status: 'loading', data: null })
    try {
      const response = await api.sessions.history({ sessionId: sessionId as WireSessionId })
      if (!response.result.ok) {
        setStats({ status: 'error', data: null })
        return
      }
      setStats({ status: 'ready', data: foldStats(response.result.value.events) })
    } catch {
      setStats({ status: 'error', data: null })
    }
  }, [api, statsId])

  // Continue a session: open it through the browser sessions service and
  // close the settings panel so the user lands directly in the conversation.
  const handleContinue = useCallback((sessionId: string): void => {
    sessions.open(sessionId as SessionId)
    close()
  }, [sessions, close])

  // Pause a running session: cancel its current turn through the host.
  const handlePause = useCallback(async (sessionId: string): Promise<void> => {
    setBusyId(sessionId)
    setNotice(null)
    try {
      const response = await fetch(PAUSE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = (await response.json().catch(() => ({}))) as ActionResultResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      showNotice({ kind: 'ok', text: strings.paused })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const suffix = code !== '' ? ` (${code})` : ''
      showNotice({ kind: 'error', text: strings.pauseFailed + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, showNotice])

  // Reveal the session's log directory in the system file manager.
  const handleOpenFolder = useCallback(async (sessionId: string): Promise<void> => {
    setBusyId(sessionId)
    setNotice(null)
    try {
      const response = await fetch(OPEN_FOLDER_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = (await response.json().catch(() => ({}))) as ActionResultResponse
      if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      showNotice({ kind: 'ok', text: strings.folderOpen })
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const suffix = code !== '' ? ` (${code})` : ''
      showNotice({ kind: 'error', text: strings.folderFailed + suffix })
    } finally {
      setBusyId(null)
    }
  }, [strings, showNotice])

  const renderStats = (sessionId: string): ReactElement | null => {
    if (statsId !== sessionId || stats === null) return null
    if (stats.status === 'loading') {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsLoading)
    }
    if (stats.status === 'error') {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsFailed)
    }
    const data = stats.data
    if (data === null || (data.turns === 0 && data.userMessages === 0 && data.assistantMessages === 0 && data.toolCalls.length === 0)) {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsEmpty)
    }
    const lines = [
      `${strings.statsTurns}: ${data.turns}`,
      `${strings.statsUser}: ${data.userMessages}`,
      `${strings.statsAssistant}: ${data.assistantMessages}`,
    ]
    if (data.toolCalls.length > 0) {
      const tools = data.toolCalls.slice(0, 5).map((tool) => `${tool.name} ×${tool.count}`).join(' · ')
      lines.push(`${strings.statsTools}: ${tools}`)
    }
    if (data.startedAt > 0 && data.updatedAt > 0) {
      lines.push(`${strings.statsWindow}: ${strings.deletedAt(data.startedAt)} ~ ${strings.deletedAt(data.updatedAt)}`)
    }
    return createElement('div', { className: 'dsh-delete-session__stats' },
      ...lines.map((line) => createElement('div', { className: 'dsh-delete-session__stats-line', key: line }, line)),
    )
  }

  const renderRow = (session: SessionSummary, isArchived: boolean): ReactElement => {
    const isCurrent = !isArchived && session.id === list.current
    const isSubagent = session.origin === 'subagent'
    const isRunning = session.running
    const busy = busyId === session.id
    const protectedReason = isCurrent ? strings.current : isSubagent ? 'subagent' : isRunning ? strings.running : ''
    const metaParts = [session.cwd ?? strings.noCwd]
    if (isArchived) metaParts.push(strings.archived)
    if (protectedReason !== '' && !isCurrent) metaParts.push(protectedReason)
    const statsOpen = statsId === session.id
    return createElement('li', {
      key: session.id,
      className: 'dsh-delete-session__row',
      'data-current': isCurrent || undefined,
      'data-current-label': strings.current,
      'data-archived': isArchived || undefined,
      'data-stats-open': statsOpen || undefined,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title', title: session.displayTitle }, session.displayTitle),
        createElement('div', { className: 'dsh-delete-session__row-meta', title: metaParts.join(' · ') }, metaParts.join(' · ')),
        renderStats(session.id),
      ),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: isRunning || busy,
        title: isRunning ? strings.running : strings.continue,
        onClick: () => handleContinue(session.id),
        children: strings.continue,
      }),
      isRunning && createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handlePause(session.id),
        children: strings.pause,
      }),
      isArchived && createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handleRestore(session.id, session.displayTitle),
        children: strings.restore,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handleStats(session.id),
        children: strings.stats,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handleOpenFolder(session.id),
        children: strings.folder,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline',
        size: 'sm',
        icon: createElement(IconTrashOutline16, { size: 16 }),
        disabled: isSubagent || isRunning || busy,
        title: protectedReason !== '' && !isCurrent ? protectedReason : strings.delete,
        onClick: () => void handleDelete(session.id, session.displayTitle),
        children: busy ? strings.deleting : strings.delete,
      }),
    )
  }

  const renderTrashRow = (entry: TrashEntry): ReactElement => {
    const title = trashEntryTitle(loadTitles(), entry, list.byId[entry.sessionId as SessionId]?.displayTitle)
    const busy = busyId === entry.sessionId
    return createElement('li', {
      key: entry.sessionId,
      className: 'dsh-delete-session__row',
      'data-trash': true,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title', title }, title),
        createElement('div', { className: 'dsh-delete-session__row-meta',
            title: [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(' · '),
          },
          [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(' · '),
        ),
      ),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        onClick: () => void handleRestore(entry.sessionId, title),
        children: strings.restore,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
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
      createElement('button', {
        type: 'button',
        className: 'dsh-delete-session__sort',
        title: newestFirst ? strings.sortOldest : strings.sortNewest,
        onClick: () => setNewestFirst((value) => !value),
        children: newestFirst ? strings.sortNewest : strings.sortOldest,
      }),
      createElement('span', { className: 'dsh-delete-session__count' }, strings.count(activeRows.length)),
    ),
    notice !== null && createElement('div', {
      className: `dsh-delete-session__notice dsh-delete-session__notice--${notice.kind}`,
    }, notice.text),
    activeRows.length === 0
      ? createElement('div', { className: 'dsh-delete-session__empty' }, strings.empty)
      : activeGroups.map((group, index) => renderWorkspaceGroup(group, index)),
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

  // The wire client: official session.history RPC for stats folding.
  const { api } = ctx.get('connection') as ConnectionHandle
  // Resolve services at the ROOT context (apply time): the slot `inject:`
  // callbacks are evaluated inside the slot's own cordis scope, where these
  // services are not declared — accessing ctx.<service> there throws
  // `cannot get property "... " without inject`.
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces

  // A dedicated Settings section (like Notifications), not a General row.
  ctx.slots.inject('settings.section', () => {
    const disposeRegistration = ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-delete-session',
      order: 60,
      label: () => t('nav'),
      locale: NS,
      inject: () => ({ api, sessions, workspaceActions: workspaces }),
    }, SessionManager)
    return () => {
      disposeRegistration()
      style.remove()
    }
  })

  // The conversation header's right-aligned utilities row (official slot that
  // also hosts the Session log button). Order, left to right:
  //   对话管理 (-40 host) → 对话管理按钮 (-30) → 回收站按钮 (-20) → 删除本对话 (-10) → Session log (0)
  ctx.slots.inject('conversation.session.header.utilities', () => {
    const common = () => ({ api, sessions })
    const disposers = [
      ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-delete-session-drawer-host',
        order: -40,
        inject: common,
      }, SessionDrawerHost),
      ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-delete-session-manage',
        order: -30,
        inject: common,
      }, HeaderManageButton),
      ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-delete-session-trash',
        order: -20,
        inject: common,
      }, HeaderTrashButton),
      ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-delete-session',
        order: -10,
        inject: () => ({}),
      }, DeleteCurrentButton),
    ]
    return () => {
      disposers.forEach((dispose) => dispose())
    }
  })
}

interface ClientContext {
  slots: SlotRegistry
  get<T>(service: string): T
  effect(effect: () => void | (() => void), label?: string): void
  sessions: import('@deepseek-ai/dsh-client-runtime/client').ISessions
  workspaces: import('@deepseek-ai/dsh-client-runtime/client').IWorkspaces
  locale: {
    register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
    bind(namespace: string): (key: 'nav') => string
  }
}

/** The framework-injected session id for the header actions slot. */
interface DeleteCurrentButtonProps {
  sessionId: string
}

/** Red "delete this session" button mounted in the conversation header. */
function DeleteCurrentButton({ sessionId }: DeleteCurrentButtonProps): ReactElement {
  const strings = stringsOf()
  const handleClick = (): void => {
    if (!window.confirm(strings.deleteCurrentConfirm)) return
    void (async () => {
      try {
        const response = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const data = (await response.json().catch(() => ({}))) as ActionResultResponse
        if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`)
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        const friendly = code === 'session-live' ? strings.deleteCurrentRunning : ''
        const suffix = friendly !== '' ? ` (${friendly})` : code !== '' ? ` (${code})` : ''
        window.alert(strings.deleteCurrentFailed + suffix)
      }
    })()
  }
  return createElement('button', {
    type: 'button',
    'data-dsh-delete-current': '',
    title: strings.deleteCurrent,
    'aria-label': strings.deleteCurrent,
    onClick: handleClick,
    children: strings.deleteCurrent,
  })
}

// ── Header drawer: session manager + trash as a self-drawn right drawer ─────

type DrawerView = 'manage' | 'trash'
interface DrawerState {
  open: boolean
  pinned: boolean
  view: DrawerView
}
const drawerState: DrawerState = { open: false, pinned: false, view: 'manage' }
const drawerListeners = new Set<() => void>()
function setDrawer(patch: Partial<DrawerState>): void {
  Object.assign(drawerState, patch)
  drawerListeners.forEach((listener) => listener())
}
/** Subscribe the calling component to the module-level drawer state. */
function useDrawerState(): DrawerState {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = () => force((value) => value + 1)
    drawerListeners.add(listener)
    return () => {
      drawerListeners.delete(listener)
    }
  }, [])
  return drawerState
}

/** Injected share for the header buttons and drawer host. */
interface DrawerInjected {
  api: Pick<import('@deepseek-ai/dsh-api-remotes/client').IApiClient, 'sessions' | 'workspace'>
  sessions: import('@deepseek-ai/dsh-client-runtime/client').ISessions
}

/** "对话管理" header button: open the drawer on the main list. */
function HeaderManageButton(_props: DrawerInjected): ReactElement {
  const strings = stringsOf()
  return createElement('button', {
    type: 'button',
    'data-dsh-header-button': '',
    title: strings.manageButton,
    onClick: () => {
      setDrawer({ open: true, view: 'manage' })
    },
    children: strings.manageButton,
  })
}

/** "回收站" header button: open the drawer with the trash expanded. */
function HeaderTrashButton(_props: DrawerInjected): ReactElement {
  const strings = stringsOf()
  return createElement('button', {
    type: 'button',
    'data-dsh-header-button': '',
    'data-dsh-header-trash': '',
    title: strings.trashButton,
    onClick: () => {
      setDrawer({ open: true, view: 'trash' })
    },
    children: strings.trashButton,
  })
}

/**
 * Drawer host: a session-scope entry that renders the drawer into a portal
 * when open. The drawer reads the full corpus itself through the wire
 * (`session.list` / `workspace.list`) because session-scope slots do not
 * receive the `useSessions`/`useWorkspaces` hooks.
 */
function SessionDrawerHost({ api, sessions }: DrawerInjected): ReactElement | null {
  const state = useDrawerState()
  if (!state.open) return null
  return createPortal(
    createElement(SessionDrawer, { api, sessions }),
    document.body,
  )
}

/** One session row in the drawer, merged with the archive set. */
interface DrawerRow {
  sessionId: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  blank: boolean
  archived: boolean
}

/** The right drawer: full session management (list, archived, trash). */
function SessionDrawer({ api, sessions }: DrawerInjected): ReactElement {
  const state = useDrawerState()
  const strings = stringsOf()
  const [rows, setRows] = useState<DrawerRow[] | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [loadError, setLoadError] = useState(false)
  const [trash, setTrash] = useState<TrashEntry[] | null>(null)
  const [trashLimit, setTrashLimit] = useState(10)
  const [trashFailed, setTrashFailed] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [trashOpen, setTrashOpen] = useState(state.view === 'trash')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [statsId, setStatsId] = useState<string | null>(null)
  const [stats, setStats] = useState<StatsState | null>(null)
  const [newestFirst, setNewestFirst] = useState(true)
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null)
  // Drop slot: 'before:<id>' inserts before that workspace, 'end' appends.
  const [dropSlot, setDropSlot] = useState<string | null>(null)
  // Mutable mirrors for pointer-drag handlers (avoid stale closures).
  const dropSlotRef = useRef<string | null>(null)
  const groupsRef = useRef<typeof activeGroups>([])

  const load = useCallback(async (): Promise<void> => {
    try {
      const [sessionsRes, workspacesRes, trashRes] = await Promise.all([
        api.sessions.list({}),
        api.workspace.list({}),
        fetch(TRASH_ROUTE),
      ])
      if (sessionsRes.result.ok && workspacesRes.result.ok) {
        const archived = new Set(workspacesRes.result.value.archivedSessionIds)
        // Blank sessions (created, never messaged) are hidden like the sidebar.
        setRows(sessionsRes.result.value.items
          .filter((summary) => !summary.blank)
          .map((summary) => ({
            sessionId: summary.sessionId,
            title: summary.projections?.values.title ?? summary.sessionId,
            cwd: summary.cwd,
            updatedAt: summary.updatedAt,
            running: summary.running,
            blank: summary.blank,
            archived: archived.has(summary.sessionId),
          })))
        setWorkspaces(workspacesRes.result.value.items)
        setLoadError(false)
      } else {
        setLoadError(true)
      }
      const trashData = (await trashRes.json().catch(() => ({}))) as TrashListResponse
      if (trashRes.ok && trashData.ok) {
        setTrash(trashData.entries)
        setTrashLimit(trashData.limit)
        setTrashFailed(false)
      } else {
        setTrashFailed(true)
      }
    } catch {
      setLoadError(true)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while the drawer is open so running/idle states stay current (the
  // wire list is a snapshot; a session that finished thinking should become
  // deletable without reopening the drawer).
  useEffect(() => {
    const timer = window.setInterval(() => {
      void load()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [load])

  const refreshTrash = useCallback(async (): Promise<void> => {
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

  const showAlert = (text: string): void => {
    window.alert(text)
  }

  const postAction = useCallback(async (route: string, sessionId: string): Promise<string | null> => {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    const data = (await response.json().catch(() => ({}))) as ActionResultResponse
    if (!response.ok || data.ok !== true) return data.error ?? `HTTP ${response.status}`
    return null
  }, [])

  const handleDelete = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.confirm.replace('{title}', title))) return
    saveTitle(sessionId, title)
    setBusyId(sessionId)
    const error = await postAction(DELETE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : 'error')
    setBusyId(null)
    if (error !== null) {
      showAlert(strings.failed.replace('{title}', title) + ` (${error})`)
      return
    }
    await Promise.all([load(), refreshTrash()])
  }, [strings, postAction, load, refreshTrash])

  const handleRestore = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.restoreConfirm.replace('{title}', title))) return
    setBusyId(sessionId)
    const error = await postAction(RESTORE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : 'error')
    setBusyId(null)
    if (error !== null) {
      showAlert(strings.restoreFailed.replace('{title}', title) + ` (${error})`)
      return
    }
    await Promise.all([load(), refreshTrash()])
  }, [strings, postAction, load, refreshTrash])

  const handlePurge = useCallback(async (sessionId: string, title: string): Promise<void> => {
    if (!window.confirm(strings.purgeConfirm.replace('{title}', title))) return
    setBusyId(sessionId)
    const error = await postAction(PURGE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : 'error')
    setBusyId(null)
    if (error !== null) {
      showAlert(strings.purgeFailed.replace('{title}', title) + ` (${error})`)
      return
    }
    await Promise.all([load(), refreshTrash()])
  }, [strings, postAction, load, refreshTrash])

  const handleStats = useCallback(async (sessionId: string): Promise<void> => {
    if (statsId === sessionId) {
      setStatsId(null)
      setStats(null)
      return
    }
    setStatsId(sessionId)
    setStats({ status: 'loading', data: null })
    try {
      const response = await api.sessions.history({ sessionId: sessionId as WireSessionId })
      if (!response.result.ok) {
        setStats({ status: 'error', data: null })
        return
      }
      setStats({ status: 'ready', data: foldStats(response.result.value.events) })
    } catch {
      setStats({ status: 'error', data: null })
    }
  }, [api, statsId])

  const handleOpenFolder = useCallback(async (sessionId: string): Promise<void> => {
    setBusyId(sessionId)
    const error = await postAction(OPEN_FOLDER_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : 'error')
    setBusyId(null)
    if (error !== null) showAlert(strings.folderFailed + ` (${error})`)
  }, [strings, postAction])

  const handleContinue = useCallback((sessionId: string): void => {
    sessions.open(sessionId as SessionId)
    setDrawer({ open: false })
  }, [sessions])

  const renderStatsBlock = (sessionId: string): ReactElement | null => {
    if (statsId !== sessionId || stats === null) return null
    if (stats.status === 'loading') {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsLoading)
    }
    if (stats.status === 'error') {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsFailed)
    }
    const data = stats.data
    if (data === null || (data.turns === 0 && data.userMessages === 0 && data.assistantMessages === 0 && data.toolCalls.length === 0)) {
      return createElement('div', { className: 'dsh-delete-session__stats' }, strings.statsEmpty)
    }
    const lines = [
      `${strings.statsTurns}: ${data.turns}`,
      `${strings.statsUser}: ${data.userMessages}`,
      `${strings.statsAssistant}: ${data.assistantMessages}`,
    ]
    if (data.toolCalls.length > 0) {
      lines.push(`${strings.statsTools}: ${data.toolCalls.slice(0, 5).map((tool) => `${tool.name} ×${tool.count}`).join(' · ')}`)
    }
    if (data.startedAt > 0 && data.updatedAt > 0) {
      lines.push(`${strings.statsWindow}: ${strings.deletedAt(data.startedAt)} ~ ${strings.deletedAt(data.updatedAt)}`)
    }
    return createElement('div', { className: 'dsh-delete-session__stats' },
      ...lines.map((line) => createElement('div', { className: 'dsh-delete-session__stats-line', key: line }, line)),
    )
  }

  const renderRow = (row: DrawerRow): ReactElement => {
    const busy = busyId === row.sessionId
    const metaParts = [row.cwd ?? strings.noCwd]
    if (row.archived) metaParts.push(strings.archived)
    if (row.running) metaParts.push(strings.running)
    return createElement('li', {
      key: row.sessionId,
      className: 'dsh-delete-session__row',
      'data-archived': row.archived || undefined,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title', title: row.title }, row.title),
        createElement('div', { className: 'dsh-delete-session__row-meta', title: metaParts.join(' · ') }, metaParts.join(' · ')),
        renderStatsBlock(row.sessionId),
      ),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm', disabled: row.running || busy,
        onClick: () => handleContinue(row.sessionId), children: strings.continue,
      }),
      row.archived && createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm', disabled: busy,
        onClick: () => void handleRestore(row.sessionId, row.title), children: strings.restore,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm', disabled: busy,
        onClick: () => void handleStats(row.sessionId), children: strings.stats,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm', disabled: busy,
        onClick: () => void handleOpenFolder(row.sessionId), children: strings.folder,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm',
        icon: createElement(IconTrashOutline16, { size: 16 }),
        disabled: row.running || busy,
        title: row.running ? strings.running : strings.delete,
        onClick: () => void handleDelete(row.sessionId, row.title),
        children: strings.delete,
      }),
    )
  }

  const renderTrashRow = (entry: TrashEntry): ReactElement => {
    const busy = busyId === entry.sessionId
    const title = trashEntryTitle(loadTitles(), entry, rows?.find((row) => row.sessionId === entry.sessionId)?.title)
    return createElement('li', {
      key: entry.sessionId,
      className: 'dsh-delete-session__row',
      'data-trash': true,
    },
      createElement('div', { className: 'dsh-delete-session__row-main' },
        createElement('div', { className: 'dsh-delete-session__row-title', title }, title),
        createElement('div', { className: 'dsh-delete-session__row-meta',
            title: [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(' · '),
          },
          [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(' · '),
        ),
      ),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm', disabled: busy,
        onClick: () => void handleRestore(entry.sessionId, title), children: strings.restore,
      }),
      createElement(Button, {
        className: 'dsh-row-action',
        variant: 'outline', size: 'sm',
        icon: createElement(IconTrashOutline16, { size: 16 }),
        disabled: busy,
        onClick: () => void handlePurge(entry.sessionId, title), children: strings.purge,
      }),
    )
  }

  const activeRows = (rows ?? []).filter((row) => !row.archived)
  // Deleted sessions sit in the trash AND stay archived; keep them out of the
  // archived group (they are already listed under the trash section).
  const trashIds = new Set((trash ?? []).map((entry) => entry.sessionId))
  const archivedRows = (rows ?? []).filter((row) => row.archived && !trashIds.has(row.sessionId))

  // Group active sessions by workspace; within each group sort by last use
  // (updatedAt), newest first by default, toggled by the drawer sort button.
  const sortRows = (list: DrawerRow[]): DrawerRow[] =>
    [...list].sort((a, b) => (newestFirst ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt))
  const activeGroups: { workspaceId: string; title: string; rows: DrawerRow[] }[] = []
  for (const view of workspaces) {
    const groupRows = sortRows(activeRows.filter((row) => view.sessionIds.includes(row.sessionId as WireSessionId)))
    if (groupRows.length > 0) activeGroups.push({ workspaceId: view.workspaceId, title: view.title || view.path, rows: groupRows })
  }
  const ungroupedActive = sortRows(activeRows.filter((row) =>
    !workspaces.some((view) => view.sessionIds.includes(row.sessionId as WireSessionId))))
  if (ungroupedActive.length > 0) activeGroups.push({ workspaceId: '__ungrouped__', title: strings.ungrouped, rows: ungroupedActive })
  groupsRef.current = activeGroups

  // Drag-and-drop workspace reordering through the official wire API.
  // Slot-based: dropping into a slot inserts the dragged workspace there;
  // dropping on a label swaps the two workspaces.
  const handleWorkspaceDrop = useCallback(async (slot: string | null): Promise<void> => {
    setDropSlot(null)
    const dragged = dragWorkspaceId
    setDragWorkspaceId(null)
    if (dragged === null || slot === null) return
    try {
      let beforeWorkspaceId: string | undefined
      if (slot.startsWith('swap:')) {
        // Swap with the target workspace.
        const swapId = slot.slice(5)
        if (swapId === dragged || swapId === '__ungrouped__') return
        const order = groupsRef.current.map((g) => g.workspaceId)
        const aIndex = order.indexOf(dragged)
        const bIndex = order.indexOf(swapId)
        beforeWorkspaceId = aIndex >= 0 && bIndex >= 0 && aIndex < bIndex ? order[bIndex + 1] : swapId
      } else if (slot.startsWith('before:')) {
        beforeWorkspaceId = slot.slice(7)
      }
      // '__end__' leaves beforeWorkspaceId undefined → appended to the very end.
      await api.workspace.insertBefore({
        workspaceId: dragged as never,
        beforeWorkspaceId: beforeWorkspaceId as never,
      })
      await load()
    } catch {
      // Reordering is best-effort; the next poll re-baselines the list.
    }
  }, [api, load, dragWorkspaceId])

  // Move a workspace to the top of the group list.
  const moveWorkspaceToTop = useCallback(async (workspaceId: string): Promise<void> => {
    const order = groupsRef.current.map((g) => g.workspaceId)
    const firstId = order.find((id) => id !== '__ungrouped__')
    if (firstId === undefined || firstId === workspaceId) return
    try {
      await api.workspace.insertBefore({
        workspaceId: workspaceId as never,
        beforeWorkspaceId: firstId as never,
      })
      await load()
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [api, load])

  // Rename a workspace through a prompt dialog.
  const renameWorkspace = useCallback(async (group: { workspaceId: string; title: string }): Promise<void> => {
    const input = window.prompt(strings.workspaceRenamePrompt.replace('{title}', group.title), group.title)
    if (input === null) return
    const title = input.trim()
    if (title === '' || title === group.title) return
    try {
      await api.workspace.rename({
        workspaceId: group.workspaceId as never,
        title: title as never,
      })
      await load()
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [api, load])

  // Delete a workspace after a confirmation dialog; its sessions fall back
  // to the ungrouped bucket.
  const deleteWorkspace = useCallback(async (group: { workspaceId: string; title: string }): Promise<void> => {
    if (!window.confirm(strings.workspaceDeleteConfirm.replace('{title}', group.title))) return
    try {
      await api.workspace.delete({
        workspaceId: group.workspaceId as never,
      })
      await load()
    } catch {
      // Best-effort; the next poll re-baselines the list.
    }
  }, [api, load])

  const renderWorkspaceLabel = (
    group: { workspaceId: string; title: string; rows: DrawerRow[] },
    index: number,
  ): ReactElement => {
    const draggable = group.workspaceId !== '__ungrouped__'
    return createElement('div', {
      className: 'dsh-delete-session__group-label' + (draggable ? ' dsh-delete-session__group-label--drag' : ''),
      'data-drag-workspace': group.workspaceId,
      'data-dragging': dragWorkspaceId === group.workspaceId || undefined,
      'data-drop-swap': dropSlot === `swap:${group.workspaceId}` || undefined,
      title: draggable ? strings.workspaceDragHint : undefined,
      onPointerDown: draggable ? (e: PointerEvent) => {
        if (e.button !== 0) return
        e.preventDefault()
        setDragWorkspaceId(group.workspaceId)
        dropSlotRef.current = null
        setDropSlot(null)
        const el = e.currentTarget as HTMLElement
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Capture is best-effort; moves still arrive while over the element.
        }
      } : undefined,
      onPointerMove: draggable ? (e: PointerEvent) => {
        if (dragWorkspaceId === null) return
        // Fuzzy judge: map the pointer Y to the nearest workspace label inside
        // this panel. Anywhere below a label (its sessions, the gap) counts as
        // that label's "after"; the upper half of the label itself is "before".
        const hit = document.elementFromPoint(e.clientX, e.clientY)
        const panel = hit instanceof Element
          ? hit.closest('[data-dsh-delete-session], [data-dsh-drawer]')
          : null
        if (panel === null) {
          dropSlotRef.current = null
          setDropSlot(null)
          return
        }
        const labels = Array.from(panel.querySelectorAll('[data-drag-workspace]'))
        const groups = groupsRef.current
        let targetIndex = -1
        for (let i = 0; i < labels.length; i++) {
          const rect = labels[i].getBoundingClientRect()
          if (e.clientY >= rect.top - 6) targetIndex = i
        }
        if (targetIndex < 0 || targetIndex >= groups.length) {
          dropSlotRef.current = null
          setDropSlot(null)
          return
        }
        const rect = labels[targetIndex].getBoundingClientRect()
        let slot: string | null
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          // On the label itself: swap the two workspaces.
          slot = `swap:${groups[targetIndex].workspaceId}`
        } else if (e.clientY < rect.top) {
          slot = `before:${groups[targetIndex].workspaceId}`
        } else {
          const next = targetIndex + 1 < groups.length ? groups[targetIndex + 1] : null
          slot = next !== null ? `before:${next.workspaceId}` : '__end__'
        }
        dropSlotRef.current = slot
        setDropSlot(slot)
      } : undefined,
      onPointerUp: draggable ? (e: PointerEvent) => {
        if (dragWorkspaceId === null) return
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          // Noop when capture was never granted.
        }
        void handleWorkspaceDrop(dropSlotRef.current)
      } : undefined,
      children: [
        createElement('span', { className: 'dsh-delete-session__group-label-text' }, `${group.title} (${group.rows.length})`),
        draggable ? createElement('span', { className: 'dsh-delete-session__group-actions' },
          createElement('button', {
            className: 'dsh-delete-session__group-action',
            type: 'button',
            title: strings.workspaceToTop,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void moveWorkspaceToTop(group.workspaceId)
            },
          }, strings.workspaceToTop),
          createElement('button', {
            className: 'dsh-delete-session__group-action',
            type: 'button',
            title: strings.workspaceRename,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void renameWorkspace(group)
            },
          }, strings.workspaceRename),
          createElement('button', {
            className: 'dsh-delete-session__group-action dsh-delete-session__group-action--danger',
            type: 'button',
            title: strings.workspaceDelete,
            onPointerDown: (e: PointerEvent) => e.stopPropagation(),
            onClick: (e: MouseEvent) => {
              e.stopPropagation()
              void deleteWorkspace(group)
            },
          }, strings.workspaceDelete),
        ) : null,
      ],
    })
  }

  // The group block is pure presentation; the thin line hugs the group edge.
  const renderWorkspaceGroup = (group: { workspaceId: string; title: string; rows: DrawerRow[] }, index: number): ReactElement => {
    const next = index + 1 < activeGroups.length ? activeGroups[index + 1] : null
    return createElement('div', {
      key: group.workspaceId,
      className: 'dsh-delete-session__group',
      'data-first': index === 0 || undefined,
      'data-line-top': dropSlot === `before:${group.workspaceId}` || undefined,
      'data-line-end': dropSlot === '__end__' && next === null || undefined,
    },
      renderWorkspaceLabel(group, index),
      createElement('ul', { className: 'dsh-delete-session__list' },
        ...group.rows.map((row) => renderRow(row)),
      ),
    )
  }

  return createElement(Fragment, null,
    !state.pinned && createElement('div', {
      'data-dsh-drawer-backdrop': '',
      onClick: () => setDrawer({ open: false }),
    }),
    createElement('div', { 'data-dsh-drawer': '' },
      createElement('div', { className: 'dsh-drawer__header' },
        createElement('span', { className: 'dsh-drawer__title' }, strings.title),
        createElement('button', {
          type: 'button',
          className: 'dsh-delete-session__sort',
          title: newestFirst ? strings.sortOldest : strings.sortNewest,
          onClick: () => setNewestFirst((value) => !value),
          children: newestFirst ? strings.sortNewest : strings.sortOldest,
        }),
        createElement('button', {
          type: 'button',
          className: 'dsh-drawer__pin',
          'data-pinned': state.pinned || undefined,
          title: state.pinned ? strings.unpin : strings.pin,
          'aria-label': state.pinned ? strings.unpin : strings.pin,
          onClick: () => setDrawer({ pinned: !state.pinned }),
          children: createElement('svg', {
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            'aria-hidden': true,
          }, createElement('path', {
            d: 'M9.6 1.6 14.4 6.4 11.2 7.4 8.6 10 9 13.4 2.6 7 6 7.4 8.6 4.8z',
            fill: 'currentColor',
          })),
        }),
        createElement('button', {
          type: 'button',
          className: 'dsh-drawer__pin',
          title: strings.close,
          'aria-label': strings.close,
          onClick: () => setDrawer({ open: false }),
          children: '×',
        }),
      ),
      createElement('div', { className: 'dsh-drawer__body' },
        state.pinned && createElement('div', { className: 'dsh-drawer__hint' }, strings.drawerPinHint),
        loadError && createElement('div', { className: 'dsh-delete-session__notice dsh-delete-session__notice--error' }, strings.trashLoadFailed),
        activeRows.length === 0
          ? createElement('div', { className: 'dsh-delete-session__empty' }, strings.empty)
          : activeGroups.map((group, index) => renderWorkspaceGroup(group, index)),
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
            ...archivedRows.map((row) => renderRow(row)),
          ),
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
      ),
    ),
  )
}
