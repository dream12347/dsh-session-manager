/**
 * Blue frontend entry for dsh-session-manager (the TUI profile).
 *
 * This is a SEPARATE Cordis plugin from the host entry (src/index.ts): it is
 * mounted through cordis.patch.yml only in Blue profiles, where it renders the
 * same sessionManagerV1 service into Blue's renderer-neutral surfaces — a
 * right-lane pane (bottom when narrow), slash commands, a status entry,
 * overlays, and notifications. Both the plugin host and the service are
 * resolved SOFTLY: in the web profile neither this file nor bluePluginHost is
 * present, and if the service has not been constructed yet the entry backs
 * out silently instead of failing the profile.
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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-session-manager/blue";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//# sourceMappingURL=blue.d.ts.map