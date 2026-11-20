// magpie-agent-purge — magpie gateway request hook.
//
// 每个经过 magpie 网关的 agent 请求会调用一次 onRequest(body, ctx)。这里按
// agent-purge 的当前人设与模式改写请求的 system 段：
//
//   off      不动请求，原样放行
//   strict   整段 system 换成人设（宿主原有的工具说明也会一起消失）
//   append   人设置于宿主 system 之前，宿主原样保留
//   replace  人设置于宿主之前，并删掉宿主 system 里「自称 + 点名模型/厂商」的行
//
// 人设与模式读自 agent-purge 的数据目录（默认 ~/.agent-purge，可用
// AGENT_PURGE_HOME 改）：
//   state.json              { "persona": "<id>", "default": { "mode": "<mode>" },
//                             "overrides": { "<agent>": { "mode", "persona" } },
//                             "disabledHarnesses": ["<agent>"] }
//                           三种「停」优先于任何模式：default.mode=off（总暂停）、
//                           overrides[agent].mode=off（这家 off）、disabledHarnesses（这家停用）
//   personas/<id>.md        frontmatter + 正文；只有正文进 prompt
//                           磁盘缺某个人设时用插件自带的 personas/ 兜底
//
// 插件 options（magpie plugin options magpie-agent-purge '<json>'）：
//   mode            覆盖 state.json 的默认模式
//   persona         覆盖当前人设 id
//   agents          只对这些 magpie agent 生效，如 ["claude","codex"]
//   disabledAgents  排除这些 magpie agent，如 ["claude"]；优先级高于 agents
//   inlinePersonas  页面导入的人设 [{ id, name, text }]；与磁盘同名时优先
//
// 失败一律 fail-open：改不动就返回 undefined，让请求原样通过。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// 插件自带的人设目录，跟 hooks.js 同级
const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "personas");

const MODES = new Set(["off", "strict", "replace", "append"]);
const MODE_LIST = ["strict", "replace", "append", "off"];
const SEP = "\n\n";
const MAX_PERSONA_ID = 128;

export const MODES_SUPPORTED = MODE_LIST;

/** agent-purge 数据目录。相对路径按当前工作目录解析，和 CLI 一致。 */
export function purgeHome(env = process.env.AGENT_PURGE_HOME) {
	const raw = typeof env === "string" ? env.trim() : "";
	if (!raw) return join(homedir(), ".agent-purge");
	return isAbsolute(raw) ? raw : resolvePath(raw);
}

/** frontmatter 绝不能进 prompt。 */
export function stripFrontmatter(raw) {
	return String(raw ?? "")
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
		.trim();
}

/** 人设 id 会拼进文件路径：挡掉分隔符、空字节、. 和 ..。 */
export function isSafePersonaId(id) {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= MAX_PERSONA_ID &&
		id !== "." &&
		id !== ".." &&
		!/[/\\\0]/.test(id)
	);
}

function readState(home) {
	const file = join(home, "state.json");
	try {
		statSync(file);
	} catch {
		return null; // 没装过 agent-purge
	}
	try {
		const state = JSON.parse(readFileSync(file, "utf8"));
		return state && typeof state === "object" && !Array.isArray(state) ? state : null;
	} catch {
		// 坏 state.json 不拦请求：按没装处理
		return null;
	}
}

/**
 * 这次请求对这个 agent 到底该不该注入。
 * 口径跟 agent-purge 自己的 resolveConfigured / resolveActivation 一致：人设与模式是
 * 「state.json 全局默认 + overrides[agent] 的例外」叠出来的，而三种「停」优先于任何
 * 模式——总暂停（default.mode=off）、这家自己 off（overrides[agent].mode=off）、
 * 这家被停用（disabledHarnesses 里）。插件读同一份状态，免得 CLI 那边已经停用了某家，
 * 这里还在往它的请求里塞人设。
 */
function activation(state, agent) {
	const stopped = (blockedBy) => ({ mode: "off", persona: null, blockedBy });
	if (!state) return stopped("missing-state");
	const override =
		agent && state.overrides?.[agent] && typeof state.overrides[agent] === "object" ? state.overrides[agent] : {};
	if (state.default?.mode === "off") return stopped("global-pause");
	if (override.mode === "off") return stopped("harness-off");
	if (agent && Array.isArray(state.disabledHarnesses) && state.disabledHarnesses.includes(agent)) {
		return stopped("harness-disabled");
	}
	return {
		// 缺省模式按 replace 兜底，跟 agent-purge 的 configured 口径一致
		mode: MODES.has(override.mode) ? override.mode : MODES.has(state.default?.mode) ? state.default.mode : "replace",
		persona: isSafePersonaId(override.persona)
			? override.persona
			: isSafePersonaId(state.persona)
				? state.persona
				: null,
		blockedBy: null,
	};
}

// 人设文件在每个请求里都可能被读；只在 mtime/size 变化时重新读盘。
const personaCache = new Map();

function readMdFile(file) {
	let stat;
	try {
		stat = statSync(file);
	} catch {
		return "";
	}
	const sig = `${stat.mtimeMs}:${stat.size}`;
	const cached = personaCache.get(file);
	if (cached && cached.sig === sig) return cached.text;
	let text = "";
	try {
		text = stripFrontmatter(readFileSync(file, "utf8"));
	} catch {
		text = "";
	}
	personaCache.set(file, { sig, text });
	return text;
}

function exists(file) {
	try {
		statSync(file);
		return true;
	} catch {
		return false;
	}
}

// 磁盘上的人设优先；磁盘没有就用插件自带的 `personas/`（换机器、还没同步
// ~/.agent-purge 时也能直接用）。
function readPersonaFile(home, id) {
	const onDisk = join(home, "personas", `${id}.md`);
	if (exists(onDisk)) return { text: readMdFile(onDisk), source: "disk" };
	const bundled = join(BUNDLED, `${id}.md`);
	if (exists(bundled)) return { text: readMdFile(bundled), source: "bundled" };
	return { text: "", source: "none" };
}

/** 决定这次请求用哪个模式、哪段人设正文。 */
export function resolvePersona(options = {}, home = purgeHome(), agent = null) {
	const cfg = activation(readState(home), agent);
	const inline = Array.isArray(options.inlinePersonas) ? options.inlinePersonas : [];
	// 停用优先于一切：options.mode 也不能把总暂停 / 分家停用顶回来
	if (cfg.blockedBy) return { mode: "off", text: "", source: "none", blockedBy: cfg.blockedBy };

	// 显式给了 persona 就以它为准；给了不合法的 id 视为没有，不回落到 state，
	// 免得一个手滑的 id 静默换成另一个人设。
	const explicit = typeof options.persona === "string" && options.persona.length > 0;
	const wanted = explicit ? (isSafePersonaId(options.persona) ? options.persona : null) : cfg.persona;
	const mode = MODES.has(options.mode) ? options.mode : cfg.mode;
	if (!wanted) return { mode, text: "", source: "none", blockedBy: null };

	// 页面导入的人设存在 options 里：命中就不读盘
	const hit = inline.find(
		(p) => p && typeof p === "object" && p.id === wanted && typeof p.text === "string" && p.text.trim(),
	);
	if (hit) return { mode, text: stripFrontmatter(hit.text), source: "inline", blockedBy: null };

	const { text, source } = readPersonaFile(home, wanted);
	return { mode, text, source: text ? source : "none", blockedBy: null };
}

// replace 只是近似：删掉「一行里同时有自称 + 点名模型/厂商」的行。
const SELF = /^\s*(?:You are|You're|你是|您是|我(?:是|现在扮演|就是))/i;
const NAMED =
	/(Claude|ChatGPT|GPT-?[45]|Gemini|Codex|Copilot|DeepSeek|Qwen|Kimi|GLM|Cursor|Windsurf|AI (?:assistant|model)|语言模型|助手)/i;

export function stripIdentity(text) {
	return String(text ?? "")
		.split("\n")
		.filter((line) => !(SELF.test(line) && NAMED.test(line)))
		.join("\n")
		.trim();
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("");
	return "";
}

// 四种 agent API 的 system 落点。Anthropic 的块结构（含 cache_control）尽量原地保留：
// 拍平成字符串会让客户端自己的缓存断点失效，每一轮都重新计费。
function rewriteAnthropic(body, persona, mode) {
	const current = body.system;
	const blocks =
		typeof current === "string"
			? current
				? [{ type: "text", text: current }]
				: []
			: Array.isArray(current)
				? current.filter((b) => b && typeof b === "object").map((b) => ({ ...b }))
				: [];
	if (mode === "strict") {
		body.system = [{ type: "text", text: persona }];
		return;
	}
	if (mode === "replace") {
		for (const block of blocks) if (typeof block.text === "string") block.text = stripIdentity(block.text);
	}
	body.system = [{ type: "text", text: persona }, ...blocks];
}

function rewriteChat(body, persona, mode) {
	if (!Array.isArray(body.messages)) body.messages = [];
	const messages = body.messages;
	const index = messages.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
	if (mode === "strict") {
		if (index >= 0) messages[index] = { role: messages[index].role, content: persona };
		else messages.unshift({ role: "system", content: persona });
		return;
	}
	if (index < 0) {
		messages.unshift({ role: "system", content: persona });
		return;
	}
	const message = messages[index];
	const host = textOf(message.content);
	const keep = mode === "replace" ? stripIdentity(host) : host;
	message.content = keep ? persona + SEP + keep : persona;
}

function rewriteResponses(body, persona, mode) {
	const host = typeof body.instructions === "string" ? body.instructions : "";
	if (mode === "strict") {
		body.instructions = persona;
		return;
	}
	const keep = mode === "replace" ? stripIdentity(host) : host;
	body.instructions = keep ? persona + SEP + keep : persona;
}

function rewriteGemini(body, persona, mode) {
	const key =
		body.systemInstruction !== undefined
			? "systemInstruction"
			: body.system_instruction !== undefined
				? "system_instruction"
				: "systemInstruction";
	const current = body[key];
	const parts = Array.isArray(current?.parts)
		? current.parts.filter((p) => p && typeof p === "object").map((p) => ({ ...p }))
		: [];
	if (mode === "strict") {
		body[key] = { parts: [{ text: persona }] };
		return;
	}
	if (mode === "replace") {
		for (const part of parts) if (typeof part.text === "string") part.text = stripIdentity(part.text);
	}
	body[key] = { ...(current ?? {}), parts: [{ text: persona }, ...parts] };
}

// 协议名与 magpie 的 ctx.protocol 对齐；不认识的一律放行。
const REWRITE = {
	anthropic: rewriteAnthropic,
	chat: rewriteChat,
	responses: rewriteResponses,
	gemini: rewriteGemini,
};

function report(ctx, state, bytes) {
	try {
		ctx?.report?.(state, bytes);
	} catch {
		/* 上报失败不能影响放行 */
	}
}

/** magpie 每请求调一次：返回改过的 body，返回 undefined 表示原样放行。 */
export async function onRequest(body, ctx = {}) {
	try {
		if (!body || typeof body !== "object" || Array.isArray(body)) return;

		const options = ctx.options && typeof ctx.options === "object" && !Array.isArray(ctx.options) ? ctx.options : {};
		const { mode, text } = resolvePersona(options, purgeHome(), ctx.agent);
		if (mode === "off" || !text) {
			report(ctx, "skipped", 0);
			return;
		}

		// 排除名单先判：同时命中 agents 与 disabledAgents 时按排除处理
		const list = (value) => (Array.isArray(value) ? value.filter((a) => typeof a === "string" && a) : []);
		const disabledAgents = list(options.disabledAgents);
		if (disabledAgents.includes(ctx.agent)) {
			report(ctx, "skipped", 0);
			return;
		}

		const agents = list(options.agents);
		if (agents.length && !agents.includes(ctx.agent)) {
			report(ctx, "skipped", 0);
			return;
		}

		const rewrite = REWRITE[ctx.protocol];
		if (!rewrite) {
			report(ctx, "unavailable", 0);
			return;
		}

		rewrite(body, text, mode);
		report(ctx, "ready", text.length);
		return body;
	} catch {
		// fail-open：改不动就原样放行，别把 agent 的请求弄挂
		report(ctx, "invalid", 0);
		return;
	}
}

export default { onRequest };