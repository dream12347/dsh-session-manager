window.__ModuleLoader__.load({
	id: "dsh-delete-session",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		let react_dom = require("react-dom");
		//#region src/contract.ts
		/**
		* Wire contract shared by the host routes and the web client panel.
		* Both halves only exchange JSON, so the contract is types plus route
		* constants — no runtime import crosses the boundary.
		*/
		/** The host route the client panel calls to delete (move to trash) one session. */
		const DELETE_ROUTE = "/dsh-delete-session/delete";
		/** Restore one session from the trash back to its original location. */
		const RESTORE_ROUTE = "/dsh-delete-session/restore";
		/** Permanently purge one session from the trash. */
		const PURGE_ROUTE = "/dsh-delete-session/purge";
		/** List the current trash contents. */
		const TRASH_ROUTE = "/dsh-delete-session/trash";
		/** Reveal a session's log directory in the system file manager. */
		const OPEN_FOLDER_ROUTE = "/dsh-delete-session/open-folder";
		/** Stop a running session's current turn (pause). */
		const PAUSE_ROUTE = "/dsh-delete-session/pause";
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-delete-session/client";
		const inject = [
			"slots",
			"locale",
			"connection",
			"sessions"
		];
		/** Locale namespace id registered under ctx.locale. */
		const NS = "dsh-delete-session";
		const NAV_ZH = { nav: "会话管理" };
		const NAV_EN = { nav: "Session Manager" };
		const STYLE_ID = "dsh-delete-session-style";
		/** localStorage key remembering sessions the user already deleted in this browser. */
		const REMOVED_KEY = "dsh-delete-session.removed";
		/** localStorage key remembering session titles at delete time, so the trash
		* can still show a name once the artifact (and the list row) is gone. */
		const TITLES_KEY = "dsh-delete-session.titles";
		function loadRemoved() {
			try {
				const raw = window.localStorage.getItem(REMOVED_KEY);
				if (raw !== null) return new Set(JSON.parse(raw));
			} catch {}
			return /* @__PURE__ */ new Set();
		}
		function saveRemoved(removed) {
			try {
				window.localStorage.setItem(REMOVED_KEY, JSON.stringify([...removed]));
			} catch {}
		}
		function loadTitles() {
			try {
				const raw = window.localStorage.getItem(TITLES_KEY);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (typeof parsed === "object" && parsed !== null) return parsed;
				}
			} catch {}
			return {};
		}
		function saveTitle(sessionId, title) {
			try {
				const next = {
					...loadTitles(),
					[sessionId]: title
				};
				window.localStorage.setItem(TITLES_KEY, JSON.stringify(next));
			} catch {}
		}
		/** Resolve a trash entry's display title: live row, remembered title, id. */
		function trashEntryTitle(titles, entry, liveTitle) {
			return liveTitle ?? titles[entry.sessionId] ?? entry.sessionId;
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
`;
		/**
		* Fold a history window into an stats. The tail page carries at most
		* `maxMessages` messages, so a long session's stats reflects its recent
		* window; `startedAt`/`updatedAt` are the window's own bounds. Events the
		* fold does not recognize are skipped.
		*/
		function foldStats(entries) {
			let turns = 0;
			let userMessages = 0;
			let assistantMessages = 0;
			const toolCounts = /* @__PURE__ */ new Map();
			let startedAt = Number.POSITIVE_INFINITY;
			let updatedAt = Number.NEGATIVE_INFINITY;
			for (const entry of entries) {
				const { type, time, data } = entry.event;
				if (time < startedAt) startedAt = time;
				if (time > updatedAt) updatedAt = time;
				if (type === "turn/start") turns += 1;
				else if (type === "user/message") userMessages += 1;
				else if (type === "assistant/message") assistantMessages += 1;
				else if (type === "tool/call") toolCounts.set(data.name, (toolCounts.get(data.name) ?? 0) + 1);
			}
			const toolCalls = [...toolCounts.entries()].map(([name, count]) => ({
				name,
				count
			})).sort((a, b) => b.count - a.count);
			return {
				turns,
				userMessages,
				assistantMessages,
				toolCalls,
				startedAt: startedAt === Number.POSITIVE_INFINITY ? 0 : startedAt,
				updatedAt: updatedAt === Number.NEGATIVE_INFINITY ? 0 : updatedAt
			};
		}
		function isZh() {
			return typeof document !== "undefined" && document.documentElement.lang.toLowerCase().startsWith("zh");
		}
		function stringsOf() {
			return isZh() ? {
				title: "会话管理",
				count: (used) => `${used} 个会话`,
				current: "当前会话",
				delete: "删除",
				deleting: "删除中…",
				confirm: "确定删除会话「{title}」吗？它会移入回收站，可在「回收站」中恢复或彻底删除。",
				deleted: "已删除会话「{title}」",
				failed: "删除会话「{title}」失败",
				liveError: "（会话正在使用中，请先停止后再删）",
				notFoundError: "（会话不存在或已被删除）",
				running: "运行中",
				archived: "已归档",
				archivedGroup: "已归档会话",
				archivedHint: "已归档会话删除后移入回收站；这里只是归档状态（侧边栏隐藏）。",
				trashGroup: "回收站",
				trashHint: "保留最近 {limit} 条已删除会话，超出后最早的一条会被自动彻底删除。",
				trashEmpty: "回收站为空。",
				trashLoadFailed: "回收站加载失败",
				restore: "恢复",
				restoreConfirm: "确定恢复会话「{title}」吗？它会回到会话列表。",
				restored: "已恢复会话「{title}」",
				restoreFailed: "恢复会话「{title}」失败",
				purge: "彻底删除",
				purgeConfirm: "确定彻底删除会话「{title}」吗？日志与记录将永久清除，无法恢复。",
				purged: "已彻底删除会话「{title}」",
				purgeFailed: "彻底删除会话「{title}」失败",
				expand: "展开",
				collapse: "收起",
				empty: "没有可管理的会话。",
				noCwd: "(未知工作目录)",
				continue: "继续会话",
				pause: "暂停",
				paused: "已暂停会话",
				pauseFailed: "暂停失败",
				stats: "统计",
				statsLoading: "统计加载中…",
				statsFailed: "统计加载失败",
				statsEmpty: "（近期窗口内没有活动）",
				statsTurns: "轮次",
				statsUser: "用户消息",
				statsAssistant: "助手消息",
				statsTools: "工具调用",
				statsWindow: "活动窗口",
				folder: "文件夹",
				folderOpen: "已在文件管理器中打开",
				folderFailed: "打开文件夹失败",
				deleteCurrent: "删除本对话",
				deleteCurrentConfirm: "确定删除当前对话吗？将移入回收站，可在「会话管理」中恢复或彻底删除。",
				deleteCurrentFailed: "删除当前对话失败",
				deleteCurrentRunning: "对话正在运行",
				manageButton: "对话管理",
				trashButton: "回收站",
				pin: "固定面板",
				unpin: "取消固定",
				drawerPinHint: "固定后面板保持打开，点击面板外不会自动收起。",
				close: "关闭",
				deletedAt: (ms) => {
					const d = new Date(ms);
					const pad = (n) => String(n).padStart(2, "0");
					return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
				}
			} : {
				title: "Session Manager",
				count: (used) => `${used} sessions`,
				current: "current session",
				delete: "Delete",
				deleting: "Deleting…",
				confirm: "Delete session \"{title}\"? It moves to the trash, where you can restore or permanently delete it.",
				deleted: "Deleted session \"{title}\"",
				failed: "Failed to delete session \"{title}\"",
				liveError: " (session is in use; stop it before deleting)",
				notFoundError: " (session does not exist or was already deleted)",
				running: "running",
				archived: "archived",
				archivedGroup: "Archived sessions",
				archivedHint: "Deleting an archived session moves it to the trash; this list is just the archived (sidebar-hidden) state.",
				trashGroup: "Trash",
				trashHint: "Keeps the most recent {limit} deleted sessions; the oldest one is purged automatically when the limit is exceeded.",
				trashEmpty: "The trash is empty.",
				trashLoadFailed: "Failed to load the trash",
				restore: "Restore",
				restoreConfirm: "Restore session \"{title}\"? It will return to the session list.",
				restored: "Restored session \"{title}\"",
				restoreFailed: "Failed to restore session \"{title}\"",
				purge: "Delete permanently",
				purgeConfirm: "Permanently delete session \"{title}\"? Its logs and records cannot be recovered.",
				purged: "Permanently deleted session \"{title}\"",
				purgeFailed: "Failed to permanently delete session \"{title}\"",
				expand: "Expand",
				collapse: "Collapse",
				empty: "No manageable sessions.",
				noCwd: "(unknown working directory)",
				continue: "Continue session",
				pause: "Pause",
				paused: "Session paused",
				pauseFailed: "Failed to pause",
				stats: "Stats",
				statsLoading: "Loading stats…",
				statsFailed: "Failed to load stats",
				statsEmpty: "(no activity in the recent window)",
				statsTurns: "turns",
				statsUser: "user messages",
				statsAssistant: "assistant messages",
				statsTools: "tool calls",
				statsWindow: "activity window",
				folder: "Folder",
				folderOpen: "Opened in the file manager",
				folderFailed: "Failed to open folder",
				deleteCurrent: "Delete this session",
				deleteCurrentConfirm: "Delete this conversation? It moves to the trash, where you can restore or permanently delete it.",
				deleteCurrentFailed: "Failed to delete this session",
				deleteCurrentRunning: "the conversation is running",
				manageButton: "Session Manager",
				trashButton: "Trash",
				pin: "Pin panel",
				unpin: "Unpin panel",
				drawerPinHint: "When pinned, the panel stays open and does not close on outside clicks.",
				close: "Close",
				deletedAt: (ms) => {
					const d = new Date(ms);
					const pad = (n) => String(n).padStart(2, "0");
					return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
				}
			};
		}
		function SessionManager({ useSessions, useWorkspaces, api, sessions, close }) {
			const list = useSessions((state) => state);
			const workspaces = useWorkspaces((state) => state);
			const [removed, setRemoved] = (0, react.useState)(() => loadRemoved());
			const [archivedOpen, setArchivedOpen] = (0, react.useState)(false);
			const [trashOpen, setTrashOpen] = (0, react.useState)(false);
			const [trash, setTrash] = (0, react.useState)(null);
			const [trashLimit, setTrashLimit] = (0, react.useState)(10);
			const [trashFailed, setTrashFailed] = (0, react.useState)(false);
			const [busyId, setBusyId] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [statsId, setStatsId] = (0, react.useState)(null);
			const [stats, setStats] = (0, react.useState)(null);
			const noticeTimer = (0, react.useRef)(void 0);
			const strings = stringsOf();
			const showNotice = (0, react.useCallback)((next) => {
				setNotice(next);
				window.clearTimeout(noticeTimer.current);
				noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
			}, []);
			(0, react.useEffect)(() => () => window.clearTimeout(noticeTimer.current), []);
			const loadTrash = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(TRASH_ROUTE);
					const data = await response.json().catch(() => ({}));
					if (response.ok && data.ok) {
						setTrash(data.entries);
						setTrashLimit(data.limit);
						setTrashFailed(false);
					} else setTrashFailed(true);
				} catch {
					setTrashFailed(true);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadTrash();
			}, [loadTrash]);
			const archivedSet = new Set(workspaces.archivedSessionIds);
			const trashIds = new Set((trash ?? []).map((entry) => entry.sessionId));
			const summaries = list.ids.map((id) => list.byId[id]).filter((session) => session !== void 0 && !removed.has(session.id) && !session.blank);
			const activeRows = summaries.filter((session) => !archivedSet.has(session.id));
			const archivedRows = summaries.filter((session) => archivedSet.has(session.id) && !trashIds.has(session.id));
			const markRemoved = (0, react.useCallback)((sessionId) => {
				setRemoved((previous) => {
					const next = new Set(previous);
					next.add(sessionId);
					saveRemoved(next);
					return next;
				});
			}, []);
			const handleDelete = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.confirm.replace("{title}", title))) return;
				saveTitle(sessionId, title);
				setBusyId(sessionId);
				setNotice(null);
				try {
					const response = await fetch(DELETE_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					await loadTrash();
					showNotice({
						kind: "ok",
						text: strings.deleted.replace("{title}", title)
					});
				} catch (error) {
					const code = error instanceof Error ? error.message : "";
					const friendly = code === "session-live" ? strings.liveError : code === "session-not-found" ? strings.notFoundError : "";
					const suffix = friendly !== "" ? friendly : code !== "" ? ` (${code})` : "";
					showNotice({
						kind: "error",
						text: strings.failed.replace("{title}", title) + suffix
					});
				} finally {
					setBusyId(null);
				}
			}, [
				strings,
				loadTrash,
				showNotice
			]);
			const handleRestore = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.restoreConfirm.replace("{title}", title))) return;
				setBusyId(sessionId);
				setNotice(null);
				try {
					const response = await fetch(RESTORE_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					await loadTrash();
					showNotice({
						kind: "ok",
						text: strings.restored.replace("{title}", title)
					});
				} catch (error) {
					const code = error instanceof Error ? error.message : "";
					const suffix = code !== "" ? ` (${code})` : "";
					showNotice({
						kind: "error",
						text: strings.restoreFailed.replace("{title}", title) + suffix
					});
				} finally {
					setBusyId(null);
				}
			}, [
				strings,
				loadTrash,
				showNotice
			]);
			const handlePurge = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.purgeConfirm.replace("{title}", title))) return;
				setBusyId(sessionId);
				setNotice(null);
				try {
					const response = await fetch(PURGE_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					markRemoved(sessionId);
					await loadTrash();
					showNotice({
						kind: "ok",
						text: strings.purged.replace("{title}", title)
					});
				} catch (error) {
					const code = error instanceof Error ? error.message : "";
					const suffix = code !== "" ? ` (${code})` : "";
					showNotice({
						kind: "error",
						text: strings.purgeFailed.replace("{title}", title) + suffix
					});
				} finally {
					setBusyId(null);
				}
			}, [
				strings,
				loadTrash,
				markRemoved,
				showNotice
			]);
			const handleStats = (0, react.useCallback)(async (sessionId) => {
				if (statsId === sessionId) {
					setStatsId(null);
					setStats(null);
					return;
				}
				setStatsId(sessionId);
				setStats({
					status: "loading",
					data: null
				});
				try {
					const response = await api.sessions.history({ sessionId });
					if (!response.result.ok) {
						setStats({
							status: "error",
							data: null
						});
						return;
					}
					setStats({
						status: "ready",
						data: foldStats(response.result.value.events)
					});
				} catch {
					setStats({
						status: "error",
						data: null
					});
				}
			}, [api, statsId]);
			const handleContinue = (0, react.useCallback)((sessionId) => {
				sessions.open(sessionId);
				close();
			}, [sessions, close]);
			const handlePause = (0, react.useCallback)(async (sessionId) => {
				setBusyId(sessionId);
				setNotice(null);
				try {
					const response = await fetch(PAUSE_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					showNotice({
						kind: "ok",
						text: strings.paused
					});
				} catch (error) {
					const code = error instanceof Error ? error.message : "";
					const suffix = code !== "" ? ` (${code})` : "";
					showNotice({
						kind: "error",
						text: strings.pauseFailed + suffix
					});
				} finally {
					setBusyId(null);
				}
			}, [strings, showNotice]);
			const handleOpenFolder = (0, react.useCallback)(async (sessionId) => {
				setBusyId(sessionId);
				setNotice(null);
				try {
					const response = await fetch(OPEN_FOLDER_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sessionId })
					});
					const data = await response.json().catch(() => ({}));
					if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					showNotice({
						kind: "ok",
						text: strings.folderOpen
					});
				} catch (error) {
					const code = error instanceof Error ? error.message : "";
					const suffix = code !== "" ? ` (${code})` : "";
					showNotice({
						kind: "error",
						text: strings.folderFailed + suffix
					});
				} finally {
					setBusyId(null);
				}
			}, [strings, showNotice]);
			const renderStats = (sessionId) => {
				if (statsId !== sessionId || stats === null) return null;
				if (stats.status === "loading") return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsLoading);
				if (stats.status === "error") return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsFailed);
				const data = stats.data;
				if (data === null || data.turns === 0 && data.userMessages === 0 && data.assistantMessages === 0 && data.toolCalls.length === 0) return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsEmpty);
				const lines = [
					`${strings.statsTurns}: ${data.turns}`,
					`${strings.statsUser}: ${data.userMessages}`,
					`${strings.statsAssistant}: ${data.assistantMessages}`
				];
				if (data.toolCalls.length > 0) {
					const tools = data.toolCalls.slice(0, 5).map((tool) => `${tool.name} ×${tool.count}`).join(" · ");
					lines.push(`${strings.statsTools}: ${tools}`);
				}
				if (data.startedAt > 0 && data.updatedAt > 0) lines.push(`${strings.statsWindow}: ${strings.deletedAt(data.startedAt)} ~ ${strings.deletedAt(data.updatedAt)}`);
				return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, ...lines.map((line) => (0, react.createElement)("div", {
					className: "dsh-delete-session__stats-line",
					key: line
				}, line)));
			};
			const renderRow = (session, isArchived) => {
				const isCurrent = !isArchived && session.id === list.current;
				const isSubagent = session.origin === "subagent";
				const isRunning = session.running;
				const busy = busyId === session.id;
				const protectedReason = isCurrent ? strings.current : isSubagent ? "subagent" : isRunning ? strings.running : "";
				const metaParts = [session.cwd ?? strings.noCwd];
				if (isArchived) metaParts.push(strings.archived);
				if (protectedReason !== "" && !isCurrent) metaParts.push(protectedReason);
				const statsOpen = statsId === session.id;
				return (0, react.createElement)("li", {
					key: session.id,
					className: "dsh-delete-session__row",
					"data-current": isCurrent || void 0,
					"data-current-label": strings.current,
					"data-archived": isArchived || void 0,
					"data-stats-open": statsOpen || void 0
				}, (0, react.createElement)("div", { className: "dsh-delete-session__row-main" }, (0, react.createElement)("div", {
					className: "dsh-delete-session__row-title",
					title: session.displayTitle
				}, session.displayTitle), (0, react.createElement)("div", {
					className: "dsh-delete-session__row-meta",
					title: metaParts.join(" · ")
				}, metaParts.join(" · ")), renderStats(session.id)), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: isRunning || busy,
					title: isRunning ? strings.running : strings.continue,
					onClick: () => handleContinue(session.id),
					children: strings.continue
				}), isRunning && (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: busy,
					onClick: () => void handlePause(session.id),
					children: strings.pause
				}), isArchived && (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: busy,
					onClick: () => void handleRestore(session.id, session.displayTitle),
					children: strings.restore
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: busy,
					onClick: () => void handleStats(session.id),
					children: strings.stats
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: busy,
					onClick: () => void handleOpenFolder(session.id),
					children: strings.folder
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					icon: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 16 }),
					disabled: isSubagent || isRunning || busy,
					title: protectedReason !== "" && !isCurrent ? protectedReason : strings.delete,
					onClick: () => void handleDelete(session.id, session.displayTitle),
					children: busy ? strings.deleting : strings.delete
				}));
			};
			const renderTrashRow = (entry) => {
				const title = trashEntryTitle(loadTitles(), entry, list.byId[entry.sessionId]?.displayTitle);
				const busy = busyId === entry.sessionId;
				return (0, react.createElement)("li", {
					key: entry.sessionId,
					className: "dsh-delete-session__row",
					"data-trash": true
				}, (0, react.createElement)("div", { className: "dsh-delete-session__row-main" }, (0, react.createElement)("div", {
					className: "dsh-delete-session__row-title",
					title
				}, title), (0, react.createElement)("div", {
					className: "dsh-delete-session__row-meta",
					title: [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(" · ")
				}, [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(" · "))), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "ghost",
					size: "sm",
					disabled: busy,
					onClick: () => void handleRestore(entry.sessionId, title),
					children: strings.restore
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					icon: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 16 }),
					disabled: busy,
					onClick: () => void handlePurge(entry.sessionId, title),
					children: strings.purge
				}));
			};
			return (0, react.createElement)("div", { "data-dsh-delete-session": "" }, (0, react.createElement)("div", { className: "dsh-delete-session__header" }, (0, react.createElement)("span", { className: "dsh-delete-session__title" }, strings.title), (0, react.createElement)("span", { className: "dsh-delete-session__count" }, strings.count(activeRows.length))), notice !== null && (0, react.createElement)("div", { className: `dsh-delete-session__notice dsh-delete-session__notice--${notice.kind}` }, notice.text), activeRows.length === 0 ? (0, react.createElement)("div", { className: "dsh-delete-session__empty" }, strings.empty) : (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...activeRows.map((session) => renderRow(session, false))), archivedRows.length > 0 && (0, react.createElement)("div", { className: "dsh-delete-session__group" }, (0, react.createElement)("button", {
				type: "button",
				className: "dsh-delete-session__group-toggle",
				onClick: () => setArchivedOpen((open) => !open),
				"aria-expanded": archivedOpen || void 0
			}, (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-label" }, `${strings.archivedGroup} (${archivedRows.length})`), (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-chevron" }, archivedOpen ? strings.collapse : strings.expand)), archivedOpen && (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...archivedRows.map((session) => renderRow(session, true))), (0, react.createElement)("div", { className: "dsh-delete-session__group-hint" }, strings.archivedHint)), trash !== null && (0, react.createElement)("div", { className: "dsh-delete-session__group" }, (0, react.createElement)("button", {
				type: "button",
				className: "dsh-delete-session__group-toggle",
				onClick: () => setTrashOpen((open) => !open),
				"aria-expanded": trashOpen || void 0
			}, (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-label" }, `${strings.trashGroup} (${trash.length}/${trashLimit})`), (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-chevron" }, trashOpen ? strings.collapse : strings.expand)), trashFailed ? (0, react.createElement)("div", { className: "dsh-delete-session__group-hint" }, strings.trashLoadFailed) : trashOpen && (trash.length === 0 ? (0, react.createElement)("div", { className: "dsh-delete-session__empty" }, strings.trashEmpty) : (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...trash.map((entry) => renderTrashRow(entry)))), (0, react.createElement)("div", { className: "dsh-delete-session__group-hint" }, strings.trashHint.replace("{limit}", String(trashLimit)))));
		}
		function apply(ctx) {
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STYLE;
			document.head.append(style);
			ctx.effect(() => ctx.locale.register(NS, {
				zh: NAV_ZH,
				en: NAV_EN
			}), "dsh-delete-session: dictionaries");
			const t = ctx.locale.bind(NS);
			const { api } = ctx.get("connection");
			ctx.slots.inject("settings.section", () => {
				const disposeRegistration = ctx.slots.register({
					name: "settings.section",
					id: "dsh-delete-session",
					order: 60,
					label: () => t("nav"),
					locale: NS,
					inject: () => ({
						api,
						sessions: ctx.sessions
					})
				}, SessionManager);
				return () => {
					disposeRegistration();
					style.remove();
				};
			});
			ctx.slots.inject("conversation.session.header.utilities", () => {
				const common = () => ({
					api,
					sessions: ctx.sessions
				});
				const disposers = [
					ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "dsh-delete-session-drawer-host",
						order: -40,
						inject: common
					}, SessionDrawerHost),
					ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "dsh-delete-session-manage",
						order: -30,
						inject: common
					}, HeaderManageButton),
					ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "dsh-delete-session-trash",
						order: -20,
						inject: common
					}, HeaderTrashButton),
					ctx.slots.register({
						name: "conversation.session.header.utilities",
						id: "dsh-delete-session",
						order: -10,
						inject: () => ({})
					}, DeleteCurrentButton)
				];
				return () => {
					disposers.forEach((dispose) => dispose());
				};
			});
		}
		/** Red "delete this session" button mounted in the conversation header. */
		function DeleteCurrentButton({ sessionId }) {
			const strings = stringsOf();
			const handleClick = () => {
				if (!window.confirm(strings.deleteCurrentConfirm)) return;
				(async () => {
					try {
						const response = await fetch(DELETE_ROUTE, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ sessionId })
						});
						const data = await response.json().catch(() => ({}));
						if (!response.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${response.status}`);
					} catch (error) {
						const code = error instanceof Error ? error.message : "";
						const friendly = code === "session-live" ? strings.deleteCurrentRunning : "";
						const suffix = friendly !== "" ? ` (${friendly})` : code !== "" ? ` (${code})` : "";
						window.alert(strings.deleteCurrentFailed + suffix);
					}
				})();
			};
			return (0, react.createElement)("button", {
				type: "button",
				"data-dsh-delete-current": "",
				title: strings.deleteCurrent,
				"aria-label": strings.deleteCurrent,
				onClick: handleClick,
				children: strings.deleteCurrent
			});
		}
		const drawerState = {
			open: false,
			pinned: false,
			view: "manage"
		};
		const drawerListeners = /* @__PURE__ */ new Set();
		function setDrawer(patch) {
			Object.assign(drawerState, patch);
			drawerListeners.forEach((listener) => listener());
		}
		/** Subscribe the calling component to the module-level drawer state. */
		function useDrawerState() {
			const [, force] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				const listener = () => force((value) => value + 1);
				drawerListeners.add(listener);
				return () => {
					drawerListeners.delete(listener);
				};
			}, []);
			return drawerState;
		}
		/** "对话管理" header button: open the drawer on the main list. */
		function HeaderManageButton(_props) {
			const strings = stringsOf();
			return (0, react.createElement)("button", {
				type: "button",
				"data-dsh-header-button": "",
				title: strings.manageButton,
				onClick: () => {
					setDrawer({
						open: true,
						view: "manage"
					});
				},
				children: strings.manageButton
			});
		}
		/** "回收站" header button: open the drawer with the trash expanded. */
		function HeaderTrashButton(_props) {
			const strings = stringsOf();
			return (0, react.createElement)("button", {
				type: "button",
				"data-dsh-header-button": "",
				"data-dsh-header-trash": "",
				title: strings.trashButton,
				onClick: () => {
					setDrawer({
						open: true,
						view: "trash"
					});
				},
				children: strings.trashButton
			});
		}
		/**
		* Drawer host: a session-scope entry that renders the drawer into a portal
		* when open. The drawer reads the full corpus itself through the wire
		* (`session.list` / `workspace.list`) because session-scope slots do not
		* receive the `useSessions`/`useWorkspaces` hooks.
		*/
		function SessionDrawerHost({ api, sessions }) {
			if (!useDrawerState().open) return null;
			return (0, react_dom.createPortal)((0, react.createElement)(SessionDrawer, {
				api,
				sessions
			}), document.body);
		}
		/** The right drawer: full session management (list, archived, trash). */
		function SessionDrawer({ api, sessions }) {
			const state = useDrawerState();
			const strings = stringsOf();
			const [rows, setRows] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(false);
			const [trash, setTrash] = (0, react.useState)(null);
			const [trashLimit, setTrashLimit] = (0, react.useState)(10);
			const [trashFailed, setTrashFailed] = (0, react.useState)(false);
			const [archivedOpen, setArchivedOpen] = (0, react.useState)(false);
			const [trashOpen, setTrashOpen] = (0, react.useState)(state.view === "trash");
			const [busyId, setBusyId] = (0, react.useState)(null);
			const [statsId, setStatsId] = (0, react.useState)(null);
			const [stats, setStats] = (0, react.useState)(null);
			const load = (0, react.useCallback)(async () => {
				try {
					const [sessionsRes, workspacesRes, trashRes] = await Promise.all([
						api.sessions.list({}),
						api.workspace.list({}),
						fetch(TRASH_ROUTE)
					]);
					if (sessionsRes.result.ok && workspacesRes.result.ok) {
						const archived = new Set(workspacesRes.result.value.archivedSessionIds);
						setRows(sessionsRes.result.value.items.filter((summary) => !summary.blank).map((summary) => ({
							sessionId: summary.sessionId,
							title: summary.projections?.values.title ?? summary.sessionId,
							cwd: summary.cwd,
							updatedAt: summary.updatedAt,
							running: summary.running,
							blank: summary.blank,
							archived: archived.has(summary.sessionId)
						})));
						setLoadError(false);
					} else setLoadError(true);
					const trashData = await trashRes.json().catch(() => ({}));
					if (trashRes.ok && trashData.ok) {
						setTrash(trashData.entries);
						setTrashLimit(trashData.limit);
						setTrashFailed(false);
					} else setTrashFailed(true);
				} catch {
					setLoadError(true);
				}
			}, [api]);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				const timer = window.setInterval(() => {
					load();
				}, 5e3);
				return () => window.clearInterval(timer);
			}, [load]);
			const refreshTrash = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(TRASH_ROUTE);
					const data = await response.json().catch(() => ({}));
					if (response.ok && data.ok) {
						setTrash(data.entries);
						setTrashLimit(data.limit);
						setTrashFailed(false);
					} else setTrashFailed(true);
				} catch {
					setTrashFailed(true);
				}
			}, []);
			const showAlert = (text) => {
				window.alert(text);
			};
			const postAction = (0, react.useCallback)(async (route, sessionId) => {
				const response = await fetch(route, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionId })
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok || data.ok !== true) return data.error ?? `HTTP ${response.status}`;
				return null;
			}, []);
			const handleDelete = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.confirm.replace("{title}", title))) return;
				saveTitle(sessionId, title);
				setBusyId(sessionId);
				const error = await postAction(DELETE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : "error");
				setBusyId(null);
				if (error !== null) {
					showAlert(strings.failed.replace("{title}", title) + ` (${error})`);
					return;
				}
				await Promise.all([load(), refreshTrash()]);
			}, [
				strings,
				postAction,
				load,
				refreshTrash
			]);
			const handleRestore = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.restoreConfirm.replace("{title}", title))) return;
				setBusyId(sessionId);
				const error = await postAction(RESTORE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : "error");
				setBusyId(null);
				if (error !== null) {
					showAlert(strings.restoreFailed.replace("{title}", title) + ` (${error})`);
					return;
				}
				await Promise.all([load(), refreshTrash()]);
			}, [
				strings,
				postAction,
				load,
				refreshTrash
			]);
			const handlePurge = (0, react.useCallback)(async (sessionId, title) => {
				if (!window.confirm(strings.purgeConfirm.replace("{title}", title))) return;
				setBusyId(sessionId);
				const error = await postAction(PURGE_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : "error");
				setBusyId(null);
				if (error !== null) {
					showAlert(strings.purgeFailed.replace("{title}", title) + ` (${error})`);
					return;
				}
				await Promise.all([load(), refreshTrash()]);
			}, [
				strings,
				postAction,
				load,
				refreshTrash
			]);
			const handleStats = (0, react.useCallback)(async (sessionId) => {
				if (statsId === sessionId) {
					setStatsId(null);
					setStats(null);
					return;
				}
				setStatsId(sessionId);
				setStats({
					status: "loading",
					data: null
				});
				try {
					const response = await api.sessions.history({ sessionId });
					if (!response.result.ok) {
						setStats({
							status: "error",
							data: null
						});
						return;
					}
					setStats({
						status: "ready",
						data: foldStats(response.result.value.events)
					});
				} catch {
					setStats({
						status: "error",
						data: null
					});
				}
			}, [api, statsId]);
			const handleOpenFolder = (0, react.useCallback)(async (sessionId) => {
				setBusyId(sessionId);
				const error = await postAction(OPEN_FOLDER_ROUTE, sessionId).catch((e) => e instanceof Error ? e.message : "error");
				setBusyId(null);
				if (error !== null) showAlert(strings.folderFailed + ` (${error})`);
			}, [strings, postAction]);
			const handleContinue = (0, react.useCallback)((sessionId) => {
				sessions.open(sessionId);
				setDrawer({ open: false });
			}, [sessions]);
			const renderStatsBlock = (sessionId) => {
				if (statsId !== sessionId || stats === null) return null;
				if (stats.status === "loading") return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsLoading);
				if (stats.status === "error") return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsFailed);
				const data = stats.data;
				if (data === null || data.turns === 0 && data.userMessages === 0 && data.assistantMessages === 0 && data.toolCalls.length === 0) return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, strings.statsEmpty);
				const lines = [
					`${strings.statsTurns}: ${data.turns}`,
					`${strings.statsUser}: ${data.userMessages}`,
					`${strings.statsAssistant}: ${data.assistantMessages}`
				];
				if (data.toolCalls.length > 0) lines.push(`${strings.statsTools}: ${data.toolCalls.slice(0, 5).map((tool) => `${tool.name} ×${tool.count}`).join(" · ")}`);
				if (data.startedAt > 0 && data.updatedAt > 0) lines.push(`${strings.statsWindow}: ${strings.deletedAt(data.startedAt)} ~ ${strings.deletedAt(data.updatedAt)}`);
				return (0, react.createElement)("div", { className: "dsh-delete-session__stats" }, ...lines.map((line) => (0, react.createElement)("div", {
					className: "dsh-delete-session__stats-line",
					key: line
				}, line)));
			};
			const renderRow = (row) => {
				const busy = busyId === row.sessionId;
				const metaParts = [row.cwd ?? strings.noCwd];
				if (row.archived) metaParts.push(strings.archived);
				if (row.running) metaParts.push(strings.running);
				return (0, react.createElement)("li", {
					key: row.sessionId,
					className: "dsh-delete-session__row",
					"data-archived": row.archived || void 0
				}, (0, react.createElement)("div", { className: "dsh-delete-session__row-main" }, (0, react.createElement)("div", {
					className: "dsh-delete-session__row-title",
					title: row.title
				}, row.title), (0, react.createElement)("div", {
					className: "dsh-delete-session__row-meta",
					title: metaParts.join(" · ")
				}, metaParts.join(" · ")), renderStatsBlock(row.sessionId)), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					disabled: row.running || busy,
					onClick: () => handleContinue(row.sessionId),
					children: strings.continue
				}), row.archived && (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => void handleRestore(row.sessionId, row.title),
					children: strings.restore
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => void handleStats(row.sessionId),
					children: strings.stats
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => void handleOpenFolder(row.sessionId),
					children: strings.folder
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					icon: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 16 }),
					disabled: row.running || busy,
					title: row.running ? strings.running : strings.delete,
					onClick: () => void handleDelete(row.sessionId, row.title),
					children: strings.delete
				}));
			};
			const renderTrashRow = (entry) => {
				const busy = busyId === entry.sessionId;
				const title = trashEntryTitle(loadTitles(), entry, rows?.find((row) => row.sessionId === entry.sessionId)?.title);
				return (0, react.createElement)("li", {
					key: entry.sessionId,
					className: "dsh-delete-session__row",
					"data-trash": true
				}, (0, react.createElement)("div", { className: "dsh-delete-session__row-main" }, (0, react.createElement)("div", {
					className: "dsh-delete-session__row-title",
					title
				}, title), (0, react.createElement)("div", {
					className: "dsh-delete-session__row-meta",
					title: [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(" · ")
				}, [entry.cwd ?? strings.noCwd, strings.deletedAt(entry.deletedAt)].join(" · "))), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					disabled: busy,
					onClick: () => void handleRestore(entry.sessionId, title),
					children: strings.restore
				}), (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					className: "dsh-row-action",
					variant: "outline",
					size: "sm",
					icon: (0, react.createElement)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, { size: 16 }),
					disabled: busy,
					onClick: () => void handlePurge(entry.sessionId, title),
					children: strings.purge
				}));
			};
			const activeRows = (rows ?? []).filter((row) => !row.archived);
			const trashIds = new Set((trash ?? []).map((entry) => entry.sessionId));
			const archivedRows = (rows ?? []).filter((row) => row.archived && !trashIds.has(row.sessionId));
			return (0, react.createElement)(react.Fragment, null, !state.pinned && (0, react.createElement)("div", {
				"data-dsh-drawer-backdrop": "",
				onClick: () => setDrawer({ open: false })
			}), (0, react.createElement)("div", { "data-dsh-drawer": "" }, (0, react.createElement)("div", { className: "dsh-drawer__header" }, (0, react.createElement)("span", { className: "dsh-drawer__title" }, strings.title), (0, react.createElement)("button", {
				type: "button",
				className: "dsh-drawer__pin",
				"data-pinned": state.pinned || void 0,
				title: state.pinned ? strings.unpin : strings.pin,
				"aria-label": state.pinned ? strings.unpin : strings.pin,
				onClick: () => setDrawer({ pinned: !state.pinned }),
				children: (0, react.createElement)("svg", {
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					"aria-hidden": true
				}, (0, react.createElement)("path", {
					d: "M9.6 1.6 14.4 6.4 11.2 7.4 8.6 10 9 13.4 2.6 7 6 7.4 8.6 4.8z",
					fill: "currentColor"
				}))
			}), (0, react.createElement)("button", {
				type: "button",
				className: "dsh-drawer__pin",
				title: strings.close,
				"aria-label": strings.close,
				onClick: () => setDrawer({ open: false }),
				children: "×"
			})), (0, react.createElement)("div", { className: "dsh-drawer__body" }, state.pinned && (0, react.createElement)("div", { className: "dsh-drawer__hint" }, strings.drawerPinHint), loadError && (0, react.createElement)("div", { className: "dsh-delete-session__notice dsh-delete-session__notice--error" }, strings.trashLoadFailed), (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...activeRows.map((row) => renderRow(row))), archivedRows.length > 0 && (0, react.createElement)("div", { className: "dsh-delete-session__group" }, (0, react.createElement)("button", {
				type: "button",
				className: "dsh-delete-session__group-toggle",
				onClick: () => setArchivedOpen((open) => !open),
				"aria-expanded": archivedOpen || void 0
			}, (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-label" }, `${strings.archivedGroup} (${archivedRows.length})`), (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-chevron" }, archivedOpen ? strings.collapse : strings.expand)), archivedOpen && (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...archivedRows.map((row) => renderRow(row)))), trash !== null && (0, react.createElement)("div", { className: "dsh-delete-session__group" }, (0, react.createElement)("button", {
				type: "button",
				className: "dsh-delete-session__group-toggle",
				onClick: () => setTrashOpen((open) => !open),
				"aria-expanded": trashOpen || void 0
			}, (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-label" }, `${strings.trashGroup} (${trash.length}/${trashLimit})`), (0, react.createElement)("span", { className: "dsh-delete-session__group-toggle-chevron" }, trashOpen ? strings.collapse : strings.expand)), trashFailed ? (0, react.createElement)("div", { className: "dsh-delete-session__group-hint" }, strings.trashLoadFailed) : trashOpen && (trash.length === 0 ? (0, react.createElement)("div", { className: "dsh-delete-session__empty" }, strings.trashEmpty) : (0, react.createElement)("ul", { className: "dsh-delete-session__list" }, ...trash.map((entry) => renderTrashRow(entry)))), (0, react.createElement)("div", { className: "dsh-delete-session__group-hint" }, strings.trashHint.replace("{limit}", String(trashLimit)))))));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
