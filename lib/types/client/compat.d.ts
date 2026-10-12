/** Type-only faces shared by the DSH 0.1.x and 0.2.x client adapters. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Both versions provide these UI adapters; their imports merge the active
// version's sessions/workspaces services and standard selector hooks.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

type HostSessionListState = ReturnType<Context['sessions']['list']['getSnapshot']>

export type SessionSummary = HostSessionListState['byId'][SessionId] & {
  /** These row fields were moved out of the session catalog in DSH 0.2.x. */
  pendingInteraction?: unknown
  completed?: boolean
}

export type SessionListState = Omit<HostSessionListState, 'byId'> & {
  byId: Record<SessionId, SessionSummary>
}

/** Host service face before the compatibility adapter supplies navigation. */
export interface SessionStoreService {
  list: {
    getSnapshot(): SessionListState
    subscribe(listener: () => void): () => void
  }
  open?(sessionId: SessionId): void
}

/** The proxy adds open() through uiWorkspace when the host no longer has it. */
export interface ISessions extends SessionStoreService {
  open(sessionId: SessionId): void
}

export type IWorkspaces = Pick<Context['workspaces'], 'list' | 'insertBefore' | 'rename' | 'delete'>
export type WorkspaceListState = ReturnType<IWorkspaces['list']['getSnapshot']>

/** Keep the canonical typed slot registration contract in both versions. */
export interface SlotRegistry {
  register: SlotCore['register']
  inject(key: keyof SlotMap & string, callback: () => () => void): () => void
}

/** Statistics only read these event fields; preserve the event discriminant. */
type StatsEvent<Event extends SessionEvent = SessionEvent> = Event extends SessionEvent
  ? Pick<Event, 'type' | 'time' | 'data'>
  : never

export interface HistoryEntry {
  event: StatsEvent
}

export type CompatResult<T> = { result: { ok: true; value: T } | { ok: false; error: { code: string } } }

/** Only the legacy RPC calls that createCompatApi implements on DSH 0.2.x. */
export interface CompatApi {
  sessions: {
    history(req: { sessionId: SessionId }): Promise<CompatResult<{ events: readonly HistoryEntry[] }>>
    fork(req: { sessionId: SessionId }): Promise<CompatResult<{ sessionId: SessionId }>>
  }
  workspace: {
    list(req: Record<string, never>): Promise<CompatResult<{
      items: readonly WorkspaceView[]
      archivedSessionIds: readonly SessionId[]
    }>>
    insertBefore(req: { workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId }): Promise<CompatResult<unknown>>
    rename(req: { workspaceId: WorkspaceId; title: string }): Promise<CompatResult<unknown>>
    delete(req: { workspaceId: WorkspaceId }): Promise<CompatResult<unknown>>
  }
}
