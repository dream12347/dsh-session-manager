import { Service } from "@deepseek-ai/cordis";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
//#region src/service.ts
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
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
const TRASH_LIMIT = 10;
function openFolderCommand(platform) {
	if (platform === "win32") return "explorer";
	if (platform === "darwin") return "open";
	return "xdg-open";
}
function openFolder(path, platform = process.platform) {
	return new Promise((resolve, reject) => {
		const child = spawn(openFolderCommand(platform), [path], {
			detached: true,
			stdio: "ignore"
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
const trashEntrySchema = z.object({
	sessionId: z.string(),
	cwd: z.string().optional(),
	originalPath: z.string().optional(),
	deletedAt: z.number()
});
/**
* The plugin's storage domain: trash entries, the compaction threshold
* setting, and the manual unread marker set. The version stays 1: the domain
* runtime rejects a medium stamped with a different version at open (there
* is no migration mechanism), so `unreadIds` is additive through a zod
* default — pre-existing version-1 globals parse unchanged.
*/
const trashDomainSpec = defineDomain({
	name: "dsh_delete_session",
	version: 1,
	global: {
		schema: z.object({
			entries: z.array(trashEntrySchema),
			thresholdRatio: z.number().optional(),
			unreadIds: z.array(z.string()).default([])
		}),
		initial: {
			entries: [],
			unreadIds: []
		}
	},
	tables: {}
});
function trashRoot() {
	return dshHomePath("dsh-delete-session-trash");
}
function trashSessionDir(sessionId) {
	return join(trashRoot(), sessionId);
}
/** Resolve the active default preset through the official agent-presets service. */
function defaultPresetName(ctx) {
	const presets = ctx.get("agentPresets");
	if (typeof presets.defaultId !== "string" || presets.defaultId.length === 0) throw new Error("agent presets default id unavailable");
	return presets.defaultId;
}
/** Resolve the real composition path and trust instead of assuming a user path. */
async function resolvePresetComposition(ctx, name) {
	const preset = await ctx.get("agentPresets").resolve(name);
	if (typeof preset.path !== "string" || preset.path.length === 0) throw new Error(`agent preset composition path unavailable: ${name}`);
	if (preset.trust !== "system" && preset.trust !== "user") throw new Error(`agent preset trust unavailable: ${name}`);
	return {
		path: preset.path,
		trust: preset.trust
	};
}
/** Read `thresholdRatio` from the preset's compaction-basic block, if any. */
function parsePresetRatio(content) {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line));
	if (start < 0) return void 0;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^\s*- id: /.test(lines[i])) break;
		const match = lines[i].match(/^\s*thresholdRatio:\s*([0-9.]+)\s*$/);
		if (match !== null) return Number(match[1]);
	}
}
/**
* Update `thresholdRatio` inside the preset's `- id: compaction-basic` block:
* reuse the existing `config:`/`thresholdRatio:` lines or insert them with
* the block's indentation. Existing content and comments stay untouched.
*/
function upsertPresetRatio(content, newline, ratio) {
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => /^\s*- id: compaction-basic\s*$/.test(line));
	if (start < 0) throw new Error("preset compaction-basic entry not found");
	const indentOf = (line) => (line.match(/^\s*/) ?? [""])[0];
	const base = indentOf(lines[start]);
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (/^\s*- id: /.test(lines[i])) {
		end = i;
		break;
	}
	const configLine = `${base}  config:`;
	const ratioLine = `${base}    thresholdRatio: ${ratio}`;
	let configIdx = -1;
	for (let i = start + 1; i < end; i++) if (/^\s*config:\s*$/.test(lines[i])) {
		configIdx = i;
		break;
	}
	if (configIdx >= 0) {
		const configIndent = indentOf(lines[configIdx]);
		let ratioIdx = -1;
		for (let i = configIdx + 1; i < end; i++) {
			if (/^\s*thresholdRatio:/.test(lines[i])) {
				ratioIdx = i;
				break;
			}
			if (indentOf(lines[i]).length <= configIndent.length && /^\S/.test(lines[i])) break;
		}
		if (ratioIdx >= 0) lines[ratioIdx] = `${configIndent}  thresholdRatio: ${ratio}`;
		else lines.splice(configIdx + 1, 0, `${configIndent}  thresholdRatio: ${ratio}`);
	} else lines.splice(end, 0, configLine, ratioLine);
	return lines.join(newline);
}
/** Read the preset file, atomically write the updated content back. */
async function writePresetComposition(path, ratio) {
	let content;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		throw new Error(`preset composition file not found: ${path}`);
	}
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	let next = upsertPresetRatio(content, newline, ratio);
	if (!next.endsWith(newline)) next += newline;
	const tmp = `${path}.tmp`;
	await writeFile(tmp, next, "utf8");
	await rename(tmp, path);
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
function syncRegistryState(ctx, next) {
	const registry = ctx.workspaceRegistry;
	if (registry !== void 0 && "state" in registry) registry.state = next;
}
/** Remove one session id from the workspace archive set through the domain. */
async function unarchive(ctx, sessionId) {
	const workspace = ctx.storageDomain.get("workspace");
	if (workspace === void 0) return;
	const state = workspace.global.get();
	if (!state.archivedSessionIds.includes(sessionId)) return;
	const next = {
		...state,
		archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
	};
	await workspace.global.set(next);
	syncRegistryState(ctx, next);
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
async function applyThresholdToLiveAgents(ctx, ratio) {
	try {
		const presets = ctx.get("agentPresets");
		if (presets?.serviceFor === void 0) return;
		const headers = await ctx.sessionPersistence.list();
		for (const header of headers) {
			const agent = ctx.agents.get(header.id);
			if (agent === void 0) continue;
			const engine = presets.serviceFor(agent, "compaction");
			if (engine === void 0 || engine.config === void 0) continue;
			engine.config.thresholdRatio = ratio;
		}
	} catch (error) {
		ctx.logger.warn("[dsh-session-manager] live-agent threshold update failed:", error);
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
function foldSessionStats(events) {
	let turns = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	const toolCounts = /* @__PURE__ */ new Map();
	let startedAt = Number.POSITIVE_INFINITY;
	let updatedAt = Number.NEGATIVE_INFINITY;
	for (const event of events) {
		if (event.time < startedAt) startedAt = event.time;
		if (event.time > updatedAt) updatedAt = event.time;
		if (event.type === "turn/start") turns += 1;
		else if (event.type === "user/message") userMessages += 1;
		else if (event.type === "assistant/message") assistantMessages += 1;
		else if (event.type === "tool/call") toolCounts.set(event.data.name, (toolCounts.get(event.data.name) ?? 0) + 1);
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
/**
* The `sessionManagerV1` service: trash/restore/purge, pause, open-folder,
* the compaction threshold, the session list, per-session activity stats, and
* the manual unread marker set. Constructed by the plugin entry once the
* storage domain is open; registered on the context through the Service base.
*/
var SessionManagerV1 = class extends Service {
	trash;
	mutationTail = Promise.resolve();
	configuredThreshold;
	constructor(ctx, trash) {
		super(ctx, "sessionManagerV1");
		this.trash = trash;
		this.configuredThreshold = trash.global.get().thresholdRatio ?? null;
	}
	/** The configured compaction threshold (null = not set), read by the
	* agent/pre-step enforcement hook registered in the plugin entry. */
	get configuredThresholdRatio() {
		return this.configuredThreshold;
	}
	getEntries() {
		return this.trash.global.get().entries;
	}
	setEntries(entries) {
		const current = this.trash.global.get();
		return this.trash.global.set({
			...current,
			entries
		}).catch((error) => {
			this.ctx.logger.warn("[dsh-session-manager] trash persist failed:", error);
			throw error;
		});
	}
	withMutationLock(operation) {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => void 0, () => void 0);
		return result;
	}
	/** Soft delete: move the session's artifact into the trash and archive it. */
	async delete(sessionId) {
		return this.withMutationLock(async () => {
			const meta = (await this.ctx.sessionPersistence.list()).find((header) => header.id === sessionId);
			const agent = this.ctx.agents.get(sessionId);
			const live = agent !== void 0;
			if (agent?.status === "running") return {
				ok: false,
				error: "session-live"
			};
			let originalPath;
			if (meta !== void 0) {
				const location = this.ctx.sessionPersistence.locate(meta);
				if (location === void 0) return {
					ok: false,
					error: "no-artifact-location"
				};
				originalPath = dirname(location.path);
			}
			const workspace = this.ctx.storageDomain.get("workspace");
			const wasArchived = workspace !== void 0 && workspace.global.get().archivedSessionIds.includes(sessionId);
			const trashPath = trashSessionDir(sessionId);
			let archiveStarted = false;
			let artifactMoved = false;
			let failureCode = "delete-failed";
			try {
				failureCode = "archive-failed";
				const registry = this.ctx.get("workspaceRegistry");
				if (registry !== void 0) {
					archiveStarted = true;
					await registry.archiveSession(sessionId);
				}
				failureCode = "delete-failed";
				{
					const currentWorkspace = this.ctx.storageDomain.get("workspace");
					if (currentWorkspace !== void 0) {
						const current = currentWorkspace.global.get();
						if (!current.archivedSessionIds.includes(sessionId)) {
							const next = {
								...current,
								archivedSessionIds: [...current.archivedSessionIds, sessionId]
							};
							await currentWorkspace.global.set(next);
							syncRegistryState(this.ctx, next);
							this.ctx.logger.debug(`[dsh-session-manager] patched archived set for ${sessionId} (stale registry cache)`);
						}
					}
				}
				if (!live && originalPath !== void 0 && existsSync(originalPath)) {
					await mkdir(trashRoot(), { recursive: true });
					await rm(trashPath, {
						recursive: true,
						force: true
					});
					await rename(originalPath, trashPath);
					artifactMoved = true;
					this.ctx.logger.debug(`[dsh-session-manager] moved ${sessionId} artifact to trash`);
				}
				const entries = this.getEntries();
				const existingIndex = entries.findIndex((entry) => entry.sessionId === sessionId);
				let next;
				let overflow = [];
				if (existingIndex >= 0) next = entries.map((entry, index) => index === existingIndex ? {
					...entry,
					deletedAt: Date.now()
				} : entry);
				else {
					next = [...entries, {
						sessionId,
						cwd: meta?.cwd,
						originalPath,
						deletedAt: Date.now()
					}];
					if (next.length > 10) {
						overflow = next.slice(0, next.length - 10);
						next = next.slice(next.length - 10);
					}
				}
				await this.setEntries(next);
				for (const entry of overflow) await rm(trashSessionDir(entry.sessionId), {
					recursive: true,
					force: true
				}).catch(() => {});
				return { ok: true };
			} catch (error) {
				if (artifactMoved && originalPath !== void 0 && existsSync(trashPath) && !existsSync(originalPath)) try {
					await mkdir(dirname(originalPath), { recursive: true });
					await rename(trashPath, originalPath);
				} catch (rollbackError) {
					this.ctx.logger.warn(`[dsh-session-manager] artifact rollback failed for ${sessionId}:`, rollbackError);
				}
				if (archiveStarted && !wasArchived) try {
					await unarchive(this.ctx, sessionId);
				} catch (rollbackError) {
					this.ctx.logger.warn(`[dsh-session-manager] archive rollback failed for ${sessionId}:`, rollbackError);
				}
				this.ctx.logger.warn(`[dsh-session-manager] ${failureCode} for ${sessionId}:`, error);
				return {
					ok: false,
					error: failureCode
				};
			}
		});
	}
	/** Restore: move the artifact back and un-archive, or un-archive only when
	* no trash entry exists (an archived-but-present session). */
	async restore(sessionId) {
		return this.withMutationLock(async () => {
			const entries = this.getEntries();
			const entry = entries.find((candidate) => candidate.sessionId === sessionId);
			if (entry === void 0) {
				const meta = (await this.ctx.sessionPersistence.list()).find((header) => header.id === sessionId);
				const agent = this.ctx.agents.get(sessionId);
				if (meta === void 0 && agent === void 0) return {
					ok: false,
					error: "trash-entry-not-found"
				};
				await unarchive(this.ctx, sessionId);
				this.ctx.logger.debug(`[dsh-session-manager] restore ${sessionId}: no trash entry, un-archived only`);
				return { ok: true };
			}
			const from = trashSessionDir(sessionId);
			if (existsSync(from)) {
				if (entry.originalPath === void 0) {
					this.ctx.logger.warn(`[dsh-session-manager] restore ${sessionId}: artifact exists in trash but entry has no original path`);
					return {
						ok: false,
						error: "no-original-path"
					};
				}
				if (existsSync(entry.originalPath)) {
					await rm(from, {
						recursive: true,
						force: true
					});
					this.ctx.logger.warn(`[dsh-session-manager] restore ${sessionId}: original path already exists, discarding trash copy`);
				} else {
					await mkdir(dirname(entry.originalPath), { recursive: true });
					await rename(from, entry.originalPath);
					this.ctx.logger.debug(`[dsh-session-manager] restored ${sessionId} artifact from trash`);
				}
			} else this.ctx.logger.debug(`[dsh-session-manager] restore ${sessionId}: no artifact in trash (live or blank session)`);
			await unarchive(this.ctx, sessionId);
			await this.setEntries(entries.filter((candidate) => candidate.sessionId !== sessionId));
			return { ok: true };
		});
	}
	/** Permanently delete one trash entry and its artifact(s). */
	async purge(sessionId) {
		return this.withMutationLock(async () => {
			const entries = this.getEntries();
			const entry = entries.find((candidate) => candidate.sessionId === sessionId);
			if (entry === void 0) return {
				ok: false,
				error: "trash-entry-not-found"
			};
			await rm(trashSessionDir(sessionId), {
				recursive: true,
				force: true
			});
			if (entry.originalPath !== void 0) await rm(entry.originalPath, {
				recursive: true,
				force: true
			});
			await this.setEntries(entries.filter((candidate) => candidate.sessionId !== sessionId));
			return { ok: true };
		});
	}
	/** Stop a running session's current turn. */
	async pause(sessionId) {
		const agent = this.ctx.agents.get(sessionId);
		if (agent === void 0) return {
			ok: false,
			error: "agent-not-found"
		};
		agent.cancel({ kind: "user" });
		return { ok: true };
	}
	/** Reveal a session's log directory in the system file manager. */
	async openFolder(sessionId) {
		let dir;
		const meta = (await this.ctx.sessionPersistence.list()).find((header) => header.id === sessionId);
		if (meta !== void 0) {
			const location = this.ctx.sessionPersistence.locate(meta);
			if (location !== void 0) dir = dirname(location.path);
		}
		if (dir === void 0 || !existsSync(dir)) {
			const entry = this.getEntries().find((candidate) => candidate.sessionId === sessionId);
			if (entry?.originalPath !== void 0 && existsSync(entry.originalPath)) dir = entry.originalPath;
		}
		if (dir === void 0 || !existsSync(dir)) return {
			ok: false,
			error: "folder-not-found"
		};
		await openFolder(dir);
		return { ok: true };
	}
	/** List the current trash contents. */
	listTrash() {
		return {
			ok: true,
			entries: this.getEntries(),
			limit: 10
		};
	}
	/**
	* Read the user-set compaction threshold. Storage is authoritative once
	* set; before the first save, fall back to the default preset file so an
	* existing value shows up.
	*/
	async getThreshold() {
		let ratio = this.configuredThreshold;
		if (ratio === null) try {
			const name = defaultPresetName(this.ctx);
			const preset = await resolvePresetComposition(this.ctx, name);
			ratio = parsePresetRatio(await readFile(preset.path, "utf8")) ?? .8;
		} catch {
			ratio = .8;
		}
		return {
			ok: true,
			ratio
		};
	}
	/**
	* Update the compaction threshold: persist it in this plugin's storage
	* domain, write it into a user preset's composition file when available
	* (system preset files are read-only), and apply it to live agents. It is
	* still enforced on EVERY session's engine at each step boundary by the
	* plugin entry's hook and survives restarts through the storage domain.
	*/
	async setThreshold(ratio) {
		try {
			return await this.withMutationLock(async () => {
				const current = this.trash.global.get();
				await this.trash.global.set({
					...current,
					thresholdRatio: ratio
				}).catch((error) => {
					this.ctx.logger.warn("[dsh-session-manager] threshold persist failed:", error);
					throw error;
				});
				this.configuredThreshold = ratio;
				const name = defaultPresetName(this.ctx);
				const preset = await resolvePresetComposition(this.ctx, name);
				if (preset.trust !== "system") await writePresetComposition(preset.path, ratio);
				await applyThresholdToLiveAgents(this.ctx, ratio);
				return { ok: true };
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.ctx.logger.warn("[dsh-session-manager] compaction-threshold update failed:", error);
			return {
				ok: false,
				error: message
			};
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
	async list() {
		const headers = await this.ctx.sessionPersistence.list();
		const archived = new Set(this.ctx.get("workspaceRegistry")?.archivedSessionIds ?? []);
		const trashed = new Set(this.getEntries().map((entry) => entry.sessionId));
		return {
			ok: true,
			sessions: await Promise.all(headers.map(async (header) => {
				const agent = this.ctx.agents.get(header.id);
				let title;
				let updatedAt = header.createdAt;
				try {
					const inspection = await this.ctx.sessionPersistence.inspect(header.id);
					for (const event of inspection.events) {
						if (event.time > updatedAt) updatedAt = event.time;
						if (event.type === "session/title") title = event.data.title;
					}
				} catch {}
				return {
					id: header.id,
					title,
					cwd: header.cwd,
					createdAt: header.createdAt,
					updatedAt,
					archived: archived.has(header.id),
					running: agent?.status === "running",
					inTrash: trashed.has(header.id)
				};
			}))
		};
	}
	/** Recent-activity statistics for one session, folded host-side from the
	* durable transcript (see foldSessionStats for the counting rules). */
	async stats(sessionId) {
		try {
			return {
				ok: true,
				stats: foldSessionStats((await this.ctx.sessionPersistence.inspect(sessionId)).events)
			};
		} catch (error) {
			this.ctx.logger.warn(`[dsh-session-manager] stats failed for ${sessionId}:`, error);
			return {
				ok: false,
				error: "stats-failed"
			};
		}
	}
	/** The current manual unread marker set. */
	getUnread() {
		return {
			ok: true,
			ids: [...this.trash.global.get().unreadIds]
		};
	}
	/** Mark one session unread/read; emits `dsh-session-manager/unread-changed`
	* with the full new set after the durable write. */
	async setUnread(sessionId, unread) {
		const current = this.trash.global.get();
		if (current.unreadIds.includes(sessionId) === unread) return { ok: true };
		const next = unread ? [...current.unreadIds, sessionId] : current.unreadIds.filter((id) => id !== sessionId);
		await this.trash.global.set({
			...current,
			unreadIds: next
		}).catch((error) => {
			this.ctx.logger.warn("[dsh-session-manager] unread persist failed:", error);
			throw error;
		});
		this.ctx.emit("dsh-session-manager/unread-changed", [...next]);
		return { ok: true };
	}
};
//#endregion
//#region src/index.ts
const name = "dsh-session-manager";
const inject = [
	"sessionPersistence",
	"agents",
	"storageDomain",
	"agentPresets"
];
const ROUTE_PREFIX = "/dsh-session-manager";
const MAX_BODY_BYTES = 65536;
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/;
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > MAX_BODY_BYTES) {
				req.destroy();
				reject(/* @__PURE__ */ new Error("request body too large"));
			}
		});
		req.on("end", () => {
			if (data.length === 0) return resolve({});
			try {
				resolve(JSON.parse(data));
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
function respond(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
function parseSessionId(body) {
	const sessionId = body?.sessionId;
	if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return void 0;
	return sessionId;
}
/** The service's machine-readable error codes mapped onto HTTP statuses;
* unknown codes (including thrown exception messages) stay 500. */
const STATUS_BY_ERROR = {
	"session-live": 409,
	"trash-entry-not-found": 404,
	"agent-not-found": 404,
	"folder-not-found": 404
};
function statusOf(result) {
	if (result.ok) return 200;
	return STATUS_BY_ERROR[result.error ?? ""] ?? 500;
}
function apply(ctx) {
	return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
		const service = new SessionManagerV1(ctx, trash);
		{
			const presets = ctx.get("agentPresets");
			ctx.on("agent/pre-step", async ({ agent }, next) => {
				try {
					const configuredThreshold = service.configuredThresholdRatio;
					if (configuredThreshold !== null && presets?.serviceFor !== void 0) {
						const engine = presets.serviceFor(agent, "compaction");
						if (engine?.config !== void 0 && engine.config.thresholdRatio !== configuredThreshold) engine.config.thresholdRatio = configuredThreshold;
					}
				} catch {}
				return next();
			}, { prepend: true });
		}
		const webServer = ctx.get("webServer");
		if (webServer === void 0) {
			ctx.logger.debug("[dsh-session-manager] no webServer service, skipping route registration");
			return () => trash.close();
		}
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/delete`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const result = await service.delete(id);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] delete failed:", error);
					respond(res, 500, {
						ok: false,
						error: "delete-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/restore`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const result = await service.restore(id);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] restore failed:", error);
					respond(res, 500, {
						ok: false,
						error: "restore-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/purge`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const result = await service.purge(id);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] purge failed:", error);
					respond(res, 500, {
						ok: false,
						error: "purge-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/pause`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const result = await service.pause(id);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] pause failed:", error);
					respond(res, 500, {
						ok: false,
						error: "pause-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/trash`,
			handler: async (_req, res) => {
				try {
					respond(res, 200, service.listTrash());
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] trash list failed:", error);
					respond(res, 500, {
						ok: false,
						error: "trash-list-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/compaction-threshold`,
			handler: async (req, res) => {
				if (req.method === "GET") {
					respond(res, 200, await service.getThreshold());
					return;
				}
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const ratio = body?.ratio;
				if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < .17 || ratio > .9) return respond(res, 400, {
					ok: false,
					error: "invalid-ratio"
				});
				try {
					const result = await service.setThreshold(ratio);
					respond(res, statusOf(result), result);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.logger.warn("[dsh-session-manager] compaction-threshold update failed:", error);
					respond(res, 500, {
						ok: false,
						error: message
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/unread`,
			handler: async (req, res) => {
				if (req.method === "GET") {
					try {
						respond(res, 200, service.getUnread());
					} catch (error) {
						ctx.logger.warn("[dsh-session-manager] unread list failed:", error);
						respond(res, 500, {
							ok: false,
							error: "unread-list-failed"
						});
					}
					return;
				}
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				const unread = body?.unread;
				if (typeof unread !== "boolean") return respond(res, 400, {
					ok: false,
					error: "bad-request"
				});
				try {
					const result = await service.setUnread(id, unread);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] unread update failed:", error);
					respond(res, 500, {
						ok: false,
						error: "unread-update-failed"
					});
				}
			}
		});
		webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/open-folder`,
			handler: async (req, res) => {
				if (req.method !== "POST") return respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				let body;
				try {
					body = await readJsonBody(req);
				} catch {
					return respond(res, 400, {
						ok: false,
						error: "bad-request"
					});
				}
				const id = parseSessionId(body);
				if (id === void 0) return respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				try {
					const result = await service.openFolder(id);
					respond(res, statusOf(result), result);
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] open-folder failed:", error);
					respond(res, 500, {
						ok: false,
						error: "open-folder-failed"
					});
				}
			}
		});
		return () => trash.close();
	});
}
//#endregion
export { SessionManagerV1, TRASH_LIMIT, apply, inject, name, openFolderCommand };
