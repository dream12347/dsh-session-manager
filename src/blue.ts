/**
 * Blue frontend entry for dsh-session-manager (the TUI profile).
 *
 * This is a SEPARATE Cordis plugin from the host entry (src/index.ts): it is
 * mounted through cordis.patch.yml only in Blue profiles, where it renders the
 * same sessionManagerV1 service into Blue's renderer-neutral surfaces — a
 * right-lane pane (bottom when narrow), slash commands, a status entry,
 * overlays, and notifications. Both the plugin host and the service are
 * resolved SOFTLY: in the web profile bluePluginHost never exists, and the
 * Blue runtime provides it from a nested bundle realm with no ordering
 * against this entry, so a missing host is awaited through the same
 * `internal/service` provide signal rather than aborting (in a profile
 * without Blue the listener simply never fires). A missing
 * sessionManagerV1 (host plugin not installed/active) no longer aborts
 * registration: the pane renders a placeholder pointing at the fix, the
 * status entry stays empty, and every command fails loudly with
 * BLUE_CAPABILITY_ABSENT. Because the sibling host entry constructs the
 * service inside an async apply, the service may also appear AFTER this
 * apply ran — cordis emits `internal/service` when a binding is provided,
 * and the listener below refreshes both surfaces when ours shows up
 * (deferred one microtask: the provide fires from the Service base
 * constructor, before the subclass fields are assigned).
 *
 * Boundary rules enforced by script/blue-plugin-validate.mjs, kept here
 * deliberately: no renderer globals/JSX/ANSI, and no imports of the
 * Agent/Session domain packages — the branded SessionId type is derived from
 * the ambient sessionManagerV1 Context merge instead of being imported, so
 * the built entry's type closure never references @deepseek-ai/dsh-session.
 *
 * Known degradations versus the web panel:
 *  - Blue exposes no pane-focus API; `session-manager` only unhides and
 *    refreshes the pane.
 *  - The status entry cannot read the CURRENT session (the capability list
 *    has no session.read), so the status dot reflects live running sessions
 *    from the service list instead.
 *  - BlueSection bodies accept only the passive BlueView subset (no nested
 *    lists/actions), so the 已归档/回收站 collapsed areas are read-only rows
 *    showing the session id; restore/purge run through the slash commands
 *    (`session-manager.restore <sessionId>` etc.), defaulting to the active
 *    list's selection.
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type {
  BluePluginHost,
  BluePublicOverlayHandle,
  BlueResult,
  BlueTone,
  BlueUiEvent,
  BlueUserGesture,
} from '@dsh-blue/blue-api'
import { validateBluePluginManifestV1 } from '@dsh-blue/blue-api/protocol/v1'
import { ui } from '@dsh-blue/blue-ui'
import type { SessionListItem, SessionStats, TrashEntry } from './contract.ts'

export const name = 'dsh-session-manager/blue'
// Deliberately empty: bluePluginHost and sessionManagerV1 are resolved softly
// inside apply so the entry also loads in profiles that lack either service.
export const inject: string[] = []

// The v1 canonical manifest is loaded from the SHIPPED blue.plugin.json at
// module scope (the official plugin-kit scaffold pattern) so the file the
// installer validates and the object opened against the host can never drift.
// A JSON import attribute would be nicer but the manifest lives outside
// tsconfig's rootDir, so the file is read through import.meta.url instead;
// the parse+validate below turns any corruption into a load-time TypeError.
const manifestSource: unknown = JSON.parse(
  readFileSync(new URL('../blue.plugin.json', import.meta.url), 'utf8'),
)
const parsedManifest = validateBluePluginManifestV1(manifestSource)
if (!parsedManifest.ok) {
  throw new TypeError(
    `dsh-session-manager: invalid blue.plugin.json: ${
      parsedManifest.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
    }`,
  )
}
const manifest = parsedManifest.value
const PANE_ID = 'session-manager.list'
const STATUS_ID = 'session-manager.status'
const LIST_ACTIVE = 'session-manager.list.active'

const OK: BlueResult = { ok: true, value: undefined }

/** The branded session id WITHOUT importing @deepseek-ai/dsh-session (see the
 * module header). Derived from the ambient Context service merge. */
type SessionId = Parameters<Context['sessionManagerV1']['delete']>[0]

interface PaneState {
  loaded: boolean
  sessions: SessionListItem[]
  trash: TrashEntry[]
  unread: string[]
  selectedId?: string
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

function rejected(message: string): BlueResult {
  return { ok: false, code: 'BLUE_ACTION_REJECTED', message }
}

function internalFailure(message: string): BlueResult {
  return { ok: false, code: 'BLUE_INTERNAL_FAILURE', message }
}

/** Command-facing failure when the host plugin's service is not there. */
function serviceAbsent(): BlueResult {
  return {
    ok: false,
    code: 'BLUE_CAPABILITY_ABSENT',
    message: 'sessionManagerV1 service unavailable: the dsh-session-manager host plugin is not active — confirm it is installed and restart Blue',
  }
}

export function apply(ctx: Context): void {
  const host = ctx.get('bluePluginHost') as BluePluginHost | undefined
  if (host !== undefined) {
    start(ctx, host)
    return
  }
  // The Blue runtime provides bluePluginHost from the bundle's nested
  // blue-runtime-private realm; nothing orders that provide against this
  // entry (inject is deliberately empty so the same row loads in profiles
  // without Blue). Same signal as the late sessionManagerV1 below: cordis
  // emits `internal/service` on every provide, so wait for the host instead
  // of backing out permanently.
  ctx.logger.debug('[dsh-session-manager/blue] bluePluginHost unavailable at apply; waiting for internal/service')
  const dispose = ctx.on('internal/service', (name) => {
    if (name !== 'bluePluginHost') return
    const late = ctx.get('bluePluginHost') as BluePluginHost | undefined
    if (late === undefined) return
    dispose()
    start(ctx, late)
  })
}

function start(ctx: Context, host: BluePluginHost): void {
  // Soft point-in-time lookup; may be undefined here and appear later (see
  // the `internal/service` listener near the bottom of apply).
  let service = ctx.get('sessionManagerV1')
  if (service === undefined) {
    ctx.logger.debug('[dsh-session-manager/blue] sessionManagerV1 unavailable, registering degraded surfaces')
  }
  const opened = host.open(ctx, manifest)
  if (!opened.ok) {
    ctx.logger.debug(`[dsh-session-manager/blue] host refused the manifest: ${opened.code} ${opened.message}`)
    return
  }
  for (const unavailable of opened.value.unavailableOptional) {
    ctx.logger.debug(`[dsh-session-manager/blue] optional capability unavailable: ${unavailable.name} (${unavailable.reason})`)
  }
  const api = opened.value.api

  const state: PaneState = {
    loaded: false,
    sessions: [],
    trash: [],
    unread: service?.getUnread().ids ?? [],
  }

  let pane: { refresh(): BlueResult, setHidden(hidden: boolean): BlueResult } | undefined
  let statusEntry: { refresh(): BlueResult } | undefined
  const refreshSurfaces = (): void => {
    pane?.refresh()
    statusEntry?.refresh()
  }

  let notificationSeq = 0
  const notify = (content: string, tone: BlueTone = 'default'): void => {
    notificationSeq += 1
    api.notifications?.publish({
      id: `dsh-session-manager/${notificationSeq}`,
      view: ui.text(content),
      tone,
    })
  }

  const labelOf = (sessionId: string): string =>
    state.sessions.find((session) => session.id === sessionId)?.title ?? sessionId

  const selectionKnown = (): boolean => {
    if (state.selectedId === undefined) return false
    return state.sessions.some((session) => session.id === state.selectedId)
      || state.trash.some((entry) => entry.sessionId === state.selectedId)
  }

  const reload = async (): Promise<void> => {
    const current = service
    if (current === undefined) {
      refreshSurfaces()
      return
    }
    try {
      const list = await current.list()
      state.sessions = list.sessions
      state.trash = current.listTrash().entries
      state.unread = current.getUnread().ids
      state.loaded = true
      if (state.selectedId !== undefined && !selectionKnown()) {
        state.selectedId = undefined
      }
    } catch (error) {
      ctx.logger.warn('[dsh-session-manager/blue] session list reload failed:', error)
    }
    refreshSurfaces()
  }

  /** Pause/restore/open-folder share one shape: run, notify, reload. */
  const runOnSession = async (
    kind: 'pause' | 'restore' | 'openFolder',
    sessionId: string,
  ): Promise<BlueResult> => {
    const current = service
    if (current === undefined) return serviceAbsent()
    const result = kind === 'pause'
      ? await current.pause(sessionId as SessionId)
      : kind === 'restore'
        ? await current.restore(sessionId as SessionId)
        : await current.openFolder(sessionId as SessionId)
    if (!result.ok) return internalFailure(result.error ?? `${kind} failed`)
    if (kind === 'pause') notify(`已暂停：${labelOf(sessionId)}`)
    else if (kind === 'restore') notify(`已恢复：${labelOf(sessionId)}`, 'success')
    await reload()
    return OK
  }

  /**
   * Delete/purge second confirmation: a capturing overlay, which Blue only
   * opens while consuming an explicit user gesture. Callers without a gesture
   * (a scripted command dispatch, for one) are rejected.
   */
  const openConfirm = (
    kind: 'delete' | 'purge',
    gesture: BlueUserGesture | undefined,
    sessionId: string | undefined,
  ): BlueResult => {
    const current = service
    if (current === undefined) return serviceAbsent()
    if (sessionId === undefined) return rejected('先在面板中选中一个会话，或传入 sessionId 参数')
    if (gesture === undefined || api.overlays === undefined) {
      return rejected('删除/彻底清除的二次确认弹窗需要一次明确的用户操作（user gesture）')
    }
    const overlays = api.overlays
    const title = kind === 'delete' ? '删除会话' : '彻底清除会话'
    const warning = kind === 'delete'
      ? `会话「${labelOf(sessionId)}」将移入回收站。`
      : `会话「${labelOf(sessionId)}」将被永久删除，该操作不可恢复。`
    let handle: BluePublicOverlayHandle | undefined
    const result = overlays.open({
      id: `session-manager.confirm-${kind}`,
      title,
      capturing: true,
      dismissible: true,
      anchor: 'center',
      width: '60%',
      render: () => ui.stack.column([
        ui.text(warning),
        ui.actions({
          id: `session-manager.confirm-${kind}.actions`,
          items: [
            { id: 'confirm', label: title, intent: 'danger' },
            { id: 'cancel', label: '取消' },
          ],
        }),
      ], { gap: 1 }),
      onEvent: async (event) => {
        if (event.kind !== 'activate') return OK
        if (event.controlId === 'cancel') {
          handle?.close()
          return OK
        }
        if (event.controlId !== 'confirm') return OK
        const action = kind === 'delete'
          ? await current.delete(sessionId as SessionId)
          : await current.purge(sessionId as SessionId)
        handle?.close()
        if (!action.ok) return internalFailure(action.error ?? `${kind} failed`)
        notify(
          kind === 'delete' ? `已删除：${labelOf(sessionId)}` : `已彻底清除：${labelOf(sessionId)}`,
          kind === 'delete' ? 'warning' : 'danger',
        )
        await reload()
        return OK
      },
    }, { userGesture: gesture })
    if (!result.ok) return result
    handle = result.value
    return OK
  }

  /** Read-only activity statistics overlay (no gesture needed: it captures no input). */
  const openStats = (sessionId: string | undefined): BlueResult => {
    const current = service
    if (current === undefined) return serviceAbsent()
    if (sessionId === undefined) return rejected('先在面板中选中一个会话，或传入 sessionId 参数')
    if (api.overlays === undefined) return rejected('overlays capability unavailable')
    let stats: SessionStats | undefined
    let failed = false
    let handle: BluePublicOverlayHandle | undefined
    const result = api.overlays.open({
      id: 'session-manager.stats',
      title: `会话统计：${labelOf(sessionId)}`,
      capturing: false,
      dismissible: true,
      anchor: 'center',
      width: '70%',
      maxHeight: '70%',
      render: () => {
        if (failed) return ui.text('统计加载失败', { tone: 'danger' })
        if (stats === undefined) return ui.loader({ message: '正在统计会话活动…' })
        return ui.stack.column([
          ui.fields([
            { label: '轮次', value: [{ text: String(stats.turns) }] },
            { label: '用户消息', value: [{ text: String(stats.userMessages) }] },
            { label: '助手消息', value: [{ text: String(stats.assistantMessages) }] },
            { label: '起始时间', value: [{ text: formatTime(stats.startedAt) }] },
            { label: '最近活动', value: [{ text: formatTime(stats.updatedAt) }] },
          ]),
          stats.toolCalls.length === 0
            ? ui.text('无工具调用记录', { tone: 'muted' })
            : ui.fields(stats.toolCalls.map((tool) => ({
              label: tool.name,
              value: [{ text: String(tool.count) }],
            }))),
        ], { gap: 1 })
      },
    })
    if (!result.ok) return result
    handle = result.value
    void current.stats(sessionId as SessionId).then((folded) => {
      if (folded.ok && folded.stats !== undefined) stats = folded.stats
      else failed = true
      handle?.refresh()
    })
    return OK
  }

  /**
   * Compaction threshold form (17%–90%). Capturing, so it too requires a user
   * gesture at open time. Invalid input re-renders the form with an error
   * instead of closing.
   */
  const openThreshold = async (gesture: BlueUserGesture | undefined): Promise<BlueResult> => {
    const current = service
    if (current === undefined) return serviceAbsent()
    if (gesture === undefined || api.overlays === undefined) {
      return rejected('阈值设置表单需要一次明确的用户操作（user gesture）')
    }
    const overlays = api.overlays
    const currentThreshold = await current.getThreshold()
    let error: string | undefined
    let handle: BluePublicOverlayHandle | undefined
    const result = overlays.open({
      id: 'session-manager.threshold',
      title: '上下文压缩阈值',
      capturing: true,
      dismissible: true,
      anchor: 'center',
      width: '60%',
      render: () => ui.stack.column([
        ui.text('会话上下文占用超过该比例时触发压缩；范围 17%–90%。', { tone: 'muted' }),
        ui.form({
          id: 'session-manager.threshold.form',
          fields: [{
            kind: 'input',
            id: 'ratio',
            label: '阈值 (%)',
            value: String(Math.round(currentThreshold.ratio * 100)),
            placeholder: '80',
            ...(error === undefined ? {} : { error }),
          }],
          submitActionId: '保存',
          cancelActionId: '取消',
        }),
      ], { gap: 1 }),
      onEvent: async (event) => {
        if (event.kind === 'activate' && event.controlId === '取消') {
          handle?.close()
          return OK
        }
        if (event.kind !== 'submit') return OK
        const values = event.values
        const raw = values !== null && typeof values === 'object'
          ? (values as { readonly ratio?: unknown })['ratio']
          : undefined
        const percent = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN
        if (!Number.isFinite(percent) || percent < 17 || percent > 90) {
          error = '阈值必须是 17–90 之间的数字'
          handle?.refresh()
          return OK
        }
        const saved = await current.setThreshold(percent / 100)
        if (!saved.ok) return internalFailure(saved.error ?? 'threshold save failed')
        handle?.close()
        notify(`阈值已保存：${percent}%`, 'success')
        return OK
      },
    }, { userGesture: gesture })
    if (!result.ok) return result
    handle = result.value
    return OK
  }

  const byCwdThenRecent = (a: SessionListItem, b: SessionListItem): number =>
    (a.cwd ?? '').localeCompare(b.cwd ?? '') || b.updatedAt - a.updatedAt

  const sessionBadge = (session: SessionListItem): string | undefined => {
    const flags: string[] = []
    if (state.unread.includes(session.id)) flags.push('未读')
    if (session.running) flags.push('运行中')
    return flags.length === 0 ? undefined : flags.join(' ')
  }

  const sessionItem = (session: SessionListItem) => ({
    id: session.id,
    label: session.title ?? session.id,
    detail: formatTime(session.updatedAt),
    badge: sessionBadge(session),
    group: session.cwd ?? '(无工作目录)',
  })

  /** Read-only rows for the collapsed areas; the session id stays visible so
   * it can be passed to the restore/purge slash commands. */
  const archivedRow = (session: SessionListItem) => ({
    label: session.title ?? session.id,
    value: [
      { text: session.id, tone: 'muted' as const },
      { text: ` · ${formatTime(session.updatedAt)}`, tone: 'muted' as const },
    ],
  })

  const trashRow = (entry: TrashEntry) => ({
    label: entry.cwd ?? entry.sessionId,
    value: [
      { text: entry.sessionId, tone: 'muted' as const },
      { text: ` · 删除于 ${formatTime(entry.deletedAt)}`, tone: 'muted' as const },
    ],
  })

  const renderPane = () => {
    if (service === undefined) {
      return ui.text('宿主插件未激活——请确认 dsh-session-manager 已安装并重启 Blue', { tone: 'muted' })
    }
    if (!state.loaded) return ui.loader({ message: '正在加载会话…' })
    const selectedIds = state.selectedId === undefined ? [] : [state.selectedId]
    const active = state.sessions
      .filter((session) => !session.archived && !session.inTrash)
      .sort(byCwdThenRecent)
    const archived = state.sessions
      .filter((session) => session.archived && !session.inTrash)
      .sort(byCwdThenRecent)
    const trash = [...state.trash].sort((a, b) => b.deletedAt - a.deletedAt)
    return ui.scroll(ui.stack.column([
      ui.list({
        id: LIST_ACTIVE,
        mode: 'single',
        selectedIds,
        items: active.map(sessionItem),
        empty: ui.empty({ title: '暂无会话' }),
      }),
      ui.sections([
        {
          title: `已归档 (${archived.length})`,
          collapsed: true,
          body: archived.length === 0
            ? ui.text('暂无已归档会话', { tone: 'muted' })
            : ui.fields(archived.map(archivedRow)),
        },
        {
          title: `回收站 (${trash.length})`,
          collapsed: true,
          body: trash.length === 0
            ? ui.text('回收站为空', { tone: 'muted' })
            : ui.fields(trash.map(trashRow)),
        },
      ]),
      ui.divider(),
      ui.text('Blue 暂未开放切换入口，请使用 /resume', { tone: 'muted' }),
      ui.actions({
        id: 'session-manager.actions',
        items: [
          { id: 'session-manager.continue', label: '继续会话', disabled: true },
          { id: 'session-manager.continue-new', label: '新聊天中继续', disabled: true },
        ],
      }),
    ], { gap: 1 }))
  }

  const onPaneEvent = (event: BlueUiEvent): BlueResult => {
    if (event.kind !== 'selection-change' || event.controlId !== LIST_ACTIVE) return OK
    if (typeof event.value !== 'string') return OK
    state.selectedId = event.value
    pane?.refresh()
    return OK
  }

  const renderStatus = () => {
    if (service === undefined) return null
    const running = state.sessions.filter((session) => session.running).length
    return ui.richText([
      { text: '●', tone: running > 0 ? 'accent' : 'muted' },
      { text: ` 会话 ${state.loaded ? state.sessions.length : '…'}` },
      { text: ` · 未读 ${state.unread.length}`, tone: state.unread.length > 0 ? 'warning' : 'muted' },
    ])
  }

  if (api.panes !== undefined) {
    const registered = api.panes.register({
      id: PANE_ID,
      title: '会话管理',
      placement: 'right',
      size: { min: 24, preferred: 32, max: 48 },
      narrow: 'bottom',
      render: renderPane,
      onEvent: onPaneEvent,
    })
    if (registered.ok) pane = registered.value
    else ctx.logger.warn(`[dsh-session-manager/blue] pane registration failed: ${registered.code} ${registered.message}`)
  }

  // The status entry is registered only once the service exists: with no
  // service it would render null anyway ("不占状态栏"), and some host-side
  // tooling compiles every contribution's render output without filtering
  // nulls. renderStatus still guards with a null return defensively.
  const registerStatus = (): void => {
    if (statusEntry !== undefined || api.status === undefined || service === undefined) return
    const registered = api.status.register({ id: STATUS_ID, render: renderStatus })
    if (registered.ok) statusEntry = registered.value
    else ctx.logger.warn(`[dsh-session-manager/blue] status registration failed: ${registered.code} ${registered.message}`)
  }
  registerStatus()

  // The unread marker set is owned by the service (host-side durable state);
  // its change event refreshes the status entry and the pane badges.
  ctx.on('dsh-session-manager/unread-changed', (ids) => {
    state.unread = [...ids]
    refreshSurfaces()
  })

  // The sibling host entry in cordis.patch.yml constructs sessionManagerV1
  // inside an async apply (after storageDomain.open), so the service may be
  // provided AFTER this apply already ran. cordis has no public
  // "service attached" event; its registry emits the documented
  // `internal/service` interception hook on every provide, which is the
  // simplest correct signal here: adopt the service and refresh both
  // surfaces (reload() no-ops the data load until then).
  //
  // The hook fires from the cordis Service base constructor, i.e. BEFORE the
  // SessionManagerV1 subclass fields are assigned — touching the instance in
  // the same tick reads `this.trash` as undefined and the throw aborts boot.
  // Deferring adoption one microtask lets the constructor finish first.
  ctx.on('internal/service', (name) => {
    if (name !== 'sessionManagerV1' || service !== undefined) return
    queueMicrotask(() => {
      service = ctx.get('sessionManagerV1')
      if (service === undefined) return
      state.unread = service.getUnread().ids
      registerStatus()
      void reload()
    })
  })

  // Commands default to the pane's current selection when no sessionId
  // argument is given.
  const sessionArg = (args: readonly string[]): string | undefined => args[0] ?? state.selectedId

  const commands = api.commands
  commands?.register({
    id: 'session-manager',
    label: '会话管理：聚焦会话面板',
    // Blue exposes no real pane-focus API; unhide + refresh is the closest
    // available behavior (see the module header).
    execute: async () => {
      if (pane === undefined) return internalFailure('session pane unavailable')
      pane.setHidden(false)
      pane.refresh()
      return OK
    },
  })
  commands?.register({
    id: 'session-manager.delete',
    label: '会话管理：删除会话（移入回收站，二次确认）',
    execute: async (args, options) =>
      openConfirm('delete', options?.userGesture, sessionArg(args)),
  })
  commands?.register({
    id: 'session-manager.restore',
    label: '会话管理：恢复会话（从回收站或已归档）',
    execute: async (args) => {
      const sessionId = sessionArg(args)
      if (sessionId === undefined) return rejected('用法：session-manager.restore <sessionId>（或在面板中选中会话）')
      return runOnSession('restore', sessionId)
    },
  })
  commands?.register({
    id: 'session-manager.purge',
    label: '会话管理：彻底清除回收站会话（不可恢复，二次确认）',
    execute: async (args, options) =>
      openConfirm('purge', options?.userGesture, sessionArg(args)),
  })
  commands?.register({
    id: 'session-manager.pause',
    label: '会话管理：暂停运行中的会话',
    execute: async (args) => {
      const sessionId = sessionArg(args)
      if (sessionId === undefined) return rejected('用法：session-manager.pause <sessionId>（或在面板中选中会话）')
      return runOnSession('pause', sessionId)
    },
  })
  commands?.register({
    id: 'session-manager.open-folder',
    label: '会话管理：打开会话日志目录',
    execute: async (args) => {
      const sessionId = sessionArg(args)
      if (sessionId === undefined) return rejected('用法：session-manager.open-folder <sessionId>（或在面板中选中会话）')
      return runOnSession('openFolder', sessionId)
    },
  })
  commands?.register({
    id: 'session-manager.threshold',
    label: '会话管理：设置上下文压缩阈值（17%–90%）',
    execute: async (_args, options) => openThreshold(options?.userGesture),
  })

  // Initial load; the pane shows a loader until the first refresh lands.
  void reload()
}
