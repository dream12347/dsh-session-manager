/**
 * Unit tests for the pure menu-injection helpers exported by the client
 * bundle. These functions carry no DOM dependency, so they run in vitest's
 * default node environment (no jsdom required).
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { findSessionByTitle, isSessionMenu } from '../menu-injection.ts'

const FORK_TEXT = '分叉会话' // official ui-workspace fork menu label (zh)

function makeSession(id: string, displayTitle: string, blank = false): SessionSummary {
  return {
    id,
    displayTitle,
    blank,
    running: false,
    updatedAt: 0,
  } as SessionSummary
}

function makeSnapshot(sessions: SessionSummary[]): Pick<SessionListState, 'ids' | 'byId'> {
  return {
    ids: sessions.map((session) => session.id),
    byId: Object.fromEntries(sessions.map((session) => [session.id, session])),
  }
}

describe('isSessionMenu', () => {
  it('detects a session menu from its fork entry', () => {
    const items = ['重命名', FORK_TEXT, '归档会话']
    expect(isSessionMenu(items, FORK_TEXT)).toBe(true)
  })

  it('rejects a workspace menu (rename/delete, no fork entry)', () => {
    const items = ['重命名', '删除']
    expect(isSessionMenu(items, FORK_TEXT)).toBe(false)
  })
})

describe('findSessionByTitle', () => {
  it('returns the matching non-blank session', () => {
    const snapshot = makeSnapshot([
      makeSession('session-1', '任务 A'),
      makeSession('session-2', '任务 B'),
    ])
    const found = findSessionByTitle(snapshot, '任务 A')
    expect(found?.id).toBe('session-1')
  })

  it('excludes blank sessions', () => {
    const snapshot = makeSnapshot([makeSession('session-blank', '未命名', true)])
    expect(findSessionByTitle(snapshot, '未命名')).toBeUndefined()
  })

  it('returns undefined when no session matches', () => {
    const snapshot = makeSnapshot([makeSession('session-1', '任务 A')])
    expect(findSessionByTitle(snapshot, '不存在的标题')).toBeUndefined()
  })
})
