/**
 * Pure helpers for the official sidebar session-row menu injection.
 *
 * Kept dependency-free (no DOM, no UI imports) so they stay unit-testable in
 * vitest's node environment and so importing them never pulls in the
 * browser-only UI dependency chain (e.g. katex CSS).
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Whether an open official row menu belongs to a SESSION row rather than a
 * Workspace row. The official session menu carries a fork entry
 * ("新聊天中继续" / "Continue in new chat") that the Workspace menu lacks, so
 * the fork label is the discriminating feature.
 * @param itemTexts - text content of the menu's `[role="menuitem"]` entries.
 * @param forkText - the current locale's fork entry label.
 * @returns true when a fork entry is present (session menu).
 */
export function isSessionMenu(itemTexts: readonly string[], forkText: string): boolean {
  return itemTexts.some((text) => text.includes(forkText))
}

/**
 * Find a non-blank session by its display title. Official sidebar rows carry
 * no session id, so the injection matches rows by title text (titles derive
 * from the same source and are unique in practice — same contract the unread
 * dot decoration relies on).
 * @param snapshot - the session list snapshot (ids + byId).
 * @param title - the row's display title to match.
 * @returns the matching session, or undefined when none (blank sessions are
 *   excluded — they have no content to delete and no menu in practice).
 */
export function findSessionByTitle(
  snapshot: Pick<SessionListState, 'ids' | 'byId'>,
  title: string,
): SessionSummary | undefined {
  for (const id of snapshot.ids) {
    const summary = snapshot.byId[id]
    if (summary !== undefined && !summary.blank && summary.displayTitle === title) return summary
  }
  return undefined
}
