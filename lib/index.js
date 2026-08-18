import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { defineDomain } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
//#region src/index.ts
const name = "dsh-session-manager";
const inject = [
	"webServer",
	"sessionPersistence",
	"workspaceRegistry",
	"agents",
	"storageDomain",
	"loader"
];
const ROUTE_PREFIX = "/dsh-session-manager";
const MAX_BODY_BYTES = 65536;
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/;
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
const TRASH_LIMIT = 10;
const trashEntrySchema = z.object({
	sessionId: z.string(),
	cwd: z.string().optional(),
	originalPath: z.string().optional(),
	deletedAt: z.number()
});
/** The plugin's storage domain: trash entries plus the compaction threshold setting. */
const trashDomainSpec = defineDomain({
	name: "dsh_delete_session",
	version: 1,
	global: {
		schema: z.object({
			entries: z.array(trashEntrySchema),
			thresholdRatio: z.number().optional()
		}),
		initial: { entries: [] }
	},
	tables: {}
});
function trashRoot() {
	return dshHomePath("dsh-delete-session-trash");
}
function trashSessionDir(sessionId) {
	return join(trashRoot(), sessionId);
}
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
/**
* In web mode the official composition disables the root `compaction-basic`
* entry; the live compaction engine lives inside the agent preset's isolated
* realm (`~/.dsh/.agent-presets/<preset>/agent.cordis.yml`, the `compaction`
* group). Reading and writing the threshold therefore targets that file —
* per-preset, i.e. per-session — line-based so user comments stay intact.
*/
/** Agent preset composition file name. */
const PRESET_COMPOSITION_FILE = "agent.cordis.yml";
/** Resolve the default agent preset name from the loader's `agent-presets` entry. */
function defaultPresetName(ctx) {
	for (const candidate of ctx.loader.entries()) if (candidate.options.id === "agent-presets") {
		const def = candidate.options.config?.default;
		if (typeof def === "string" && def.length > 0) return def;
	}
	return "standard";
}
/** Absolute path of one preset's agent composition file. */
function presetPath(name) {
	return dshHomePath(".agent-presets", name, PRESET_COMPOSITION_FILE);
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
async function writePresetComposition(ctx, name, ratio) {
	const path = presetPath(name);
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
* silent un-archives/archives that disagree with what clients see.
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
* resolved threshold field takes effect immediately. Best-effort: failures
* only warn.
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
function apply(ctx) {
	return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
		const getEntries = () => trash.global.get().entries;
		const setEntries = (entries) => trash.global.set({ entries }).catch((error) => {
			ctx.logger.warn("[dsh-session-manager] trash persist failed:", error);
			throw error;
		});
		let configuredThreshold = trash.global.get().thresholdRatio ?? null;
		const setConfiguredThreshold = async (ratio) => {
			configuredThreshold = ratio;
			const current = trash.global.get();
			await trash.global.set({
				...current,
				thresholdRatio: ratio
			}).catch((error) => {
				ctx.logger.warn("[dsh-session-manager] threshold persist failed:", error);
				throw error;
			});
		};
		{
			const presets = ctx.get("agentPresets");
			ctx.on("agent/pre-step", async ({ agent }, next) => {
				try {
					if (configuredThreshold !== null && presets?.serviceFor !== void 0) {
						const engine = presets.serviceFor(agent, "compaction");
						if (engine?.config !== void 0 && engine.config.thresholdRatio !== configuredThreshold) engine.config.thresholdRatio = configuredThreshold;
					}
				} catch {}
				return next();
			}, { prepend: true });
		}
		ctx.webServer.register({
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
					const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
					const agent = ctx.agents.get(id);
					const live = agent !== void 0;
					if (agent?.status === "running") return respond(res, 409, {
						ok: false,
						error: "session-live"
					});
					try {
						await ctx.workspaceRegistry.archiveSession(id);
					} catch (error) {
						ctx.logger.warn(`[dsh-session-manager] archive failed for ${id}, aborting delete:`, error);
						return respond(res, 500, {
							ok: false,
							error: "archive-failed"
						});
					}
					{
						const workspace = ctx.storageDomain.get("workspace");
						if (workspace !== void 0) {
							const current = workspace.global.get();
							if (!current.archivedSessionIds.includes(id)) {
								const next = {
									...current,
									archivedSessionIds: [...current.archivedSessionIds, id]
								};
								await workspace.global.set(next);
								syncRegistryState(ctx, next);
								ctx.logger.debug(`[dsh-session-manager] patched archived set for ${id} (stale registry cache)`);
							}
						}
					}
					let originalPath;
					if (meta !== void 0) {
						const location = ctx.sessionPersistence.locate(meta);
						if (location === void 0) return respond(res, 500, {
							ok: false,
							error: "no-artifact-location"
						});
						originalPath = dirname(location.path);
					}
					if (!live && originalPath !== void 0 && existsSync(originalPath)) {
						await mkdir(trashRoot(), { recursive: true });
						await rm(trashSessionDir(id), {
							recursive: true,
							force: true
						});
						await rename(originalPath, trashSessionDir(id));
						ctx.logger.debug(`[dsh-session-manager] moved ${id} artifact to trash`);
					}
					const entries = getEntries();
					const existingIndex = entries.findIndex((entry) => entry.sessionId === id);
					let next;
					if (existingIndex >= 0) next = entries.map((entry, index) => index === existingIndex ? {
						...entry,
						deletedAt: Date.now()
					} : entry);
					else {
						next = [...entries, {
							sessionId: id,
							cwd: meta?.cwd,
							originalPath,
							deletedAt: Date.now()
						}];
						if (next.length > 10) {
							const overflow = next.slice(0, next.length - 10);
							for (const entry of overflow) await rm(trashSessionDir(entry.sessionId), {
								recursive: true,
								force: true
							}).catch(() => {});
							next = next.slice(next.length - 10);
						}
					}
					await setEntries(next);
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] delete failed:", error);
					respond(res, 500, {
						ok: false,
						error: "delete-failed"
					});
				}
			}
		});
		ctx.webServer.register({
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
					const entries = getEntries();
					const entry = entries.find((candidate) => candidate.sessionId === id);
					if (entry === void 0) {
						const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
						const agent = ctx.agents.get(id);
						if (meta === void 0 && agent === void 0) return respond(res, 404, {
							ok: false,
							error: "trash-entry-not-found"
						});
						await unarchive(ctx, id);
						ctx.logger.debug(`[dsh-session-manager] restore ${id}: no trash entry, un-archived only`);
						return respond(res, 200, { ok: true });
					}
					const from = trashSessionDir(id);
					if (existsSync(from)) {
						if (entry.originalPath === void 0) {
							ctx.logger.warn(`[dsh-session-manager] restore ${id}: artifact exists in trash but entry has no original path`);
							return respond(res, 500, {
								ok: false,
								error: "no-original-path"
							});
						}
						if (existsSync(entry.originalPath)) {
							await rm(from, {
								recursive: true,
								force: true
							});
							ctx.logger.warn(`[dsh-session-manager] restore ${id}: original path already exists, discarding trash copy`);
						} else {
							await mkdir(dirname(entry.originalPath), { recursive: true });
							await rename(from, entry.originalPath);
							ctx.logger.debug(`[dsh-session-manager] restored ${id} artifact from trash`);
						}
					} else ctx.logger.debug(`[dsh-session-manager] restore ${id}: no artifact in trash (live or blank session)`);
					await unarchive(ctx, id);
					await setEntries(entries.filter((candidate) => candidate.sessionId !== id));
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] restore failed:", error);
					respond(res, 500, {
						ok: false,
						error: "restore-failed"
					});
				}
			}
		});
		ctx.webServer.register({
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
					const entries = getEntries();
					const entry = entries.find((candidate) => candidate.sessionId === id);
					if (entry === void 0) return respond(res, 404, {
						ok: false,
						error: "trash-entry-not-found"
					});
					await rm(trashSessionDir(id), {
						recursive: true,
						force: true
					});
					if (entry.originalPath !== void 0) await rm(entry.originalPath, {
						recursive: true,
						force: true
					});
					await setEntries(entries.filter((candidate) => candidate.sessionId !== id));
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] purge failed:", error);
					respond(res, 500, {
						ok: false,
						error: "purge-failed"
					});
				}
			}
		});
		ctx.webServer.register({
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
					const agent = ctx.agents.get(id);
					if (agent === void 0) return respond(res, 404, {
						ok: false,
						error: "agent-not-found"
					});
					agent.cancel({ kind: "user" });
					respond(res, 200, { ok: true });
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] pause failed:", error);
					respond(res, 500, {
						ok: false,
						error: "pause-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/trash`,
			handler: async (_req, res) => {
				try {
					respond(res, 200, {
						ok: true,
						entries: getEntries(),
						limit: 10
					});
				} catch (error) {
					ctx.logger.warn("[dsh-session-manager] trash list failed:", error);
					respond(res, 500, {
						ok: false,
						error: "trash-list-failed"
					});
				}
			}
		});
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/compaction-threshold`,
			handler: async (req, res) => {
				if (req.method === "GET") {
					let ratio = configuredThreshold;
					if (ratio === null) try {
						const name = defaultPresetName(ctx);
						ratio = parsePresetRatio(await readFile(presetPath(name), "utf8")) ?? .8;
					} catch {
						ratio = .8;
					}
					respond(res, 200, {
						ok: true,
						ratio
					});
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
					await setConfiguredThreshold(ratio);
					await writePresetComposition(ctx, defaultPresetName(ctx), ratio);
					await applyThresholdToLiveAgents(ctx, ratio);
					respond(res, 200, { ok: true });
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
		ctx.webServer.register({
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
					let dir;
					const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
					if (meta !== void 0) {
						const location = ctx.sessionPersistence.locate(meta);
						if (location !== void 0) dir = dirname(location.path);
					}
					if (dir === void 0 || !existsSync(dir)) {
						const entry = getEntries().find((candidate) => candidate.sessionId === id);
						if (entry?.originalPath !== void 0 && existsSync(entry.originalPath)) dir = entry.originalPath;
					}
					if (dir === void 0 || !existsSync(dir)) return respond(res, 404, {
						ok: false,
						error: "folder-not-found"
					});
					if (process.platform === "win32") spawn("explorer", [dir], {
						detached: true,
						stdio: "ignore"
					}).unref();
					else spawn("xdg-open", [dir], {
						detached: true,
						stdio: "ignore"
					}).unref();
					respond(res, 200, { ok: true });
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
export { TRASH_LIMIT, apply, inject, name };
