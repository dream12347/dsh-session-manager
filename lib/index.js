import { rm } from "node:fs/promises";
import { dirname } from "node:path";
//#region src/index.ts
const name = "dsh-delete-session";
const inject = [
	"webServer",
	"sessionPersistence",
	"workspaceRegistry",
	"agents"
];
const ROUTE_PATH = "/dsh-delete-session/delete";
const MAX_BODY_BYTES = 65536;
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,}$/;
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
function apply(ctx) {
	ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				respond(res, 405, {
					ok: false,
					error: "method-not-allowed"
				});
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch {
				respond(res, 400, {
					ok: false,
					error: "bad-request"
				});
				return;
			}
			const sessionId = body?.sessionId;
			if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
				respond(res, 400, {
					ok: false,
					error: "invalid-session-id"
				});
				return;
			}
			const id = sessionId;
			try {
				const meta = (await ctx.sessionPersistence.list()).find((header) => header.id === id);
				const agent = ctx.agents.get(id);
				if (meta?.origin === "subagent") {
					respond(res, 400, {
						ok: false,
						error: "subagent-session"
					});
					return;
				}
				if (agent?.status === "running") {
					respond(res, 409, {
						ok: false,
						error: "session-live"
					});
					return;
				}
				if (meta !== void 0) {
					const location = ctx.sessionPersistence.locate(meta);
					if (location === void 0) {
						respond(res, 500, {
							ok: false,
							error: "no-artifact-location"
						});
						return;
					}
					await rm(dirname(location.path), {
						recursive: true,
						force: true
					});
				}
				await ctx.workspaceRegistry.archiveSession(id).catch(() => {});
				respond(res, 200, { ok: true });
			} catch (error) {
				ctx.logger.warn("[dsh-delete-session] delete failed:", error);
				respond(res, 500, {
					ok: false,
					error: "delete-failed"
				});
			}
		}
	});
}
//#endregion
export { apply, inject, name };
