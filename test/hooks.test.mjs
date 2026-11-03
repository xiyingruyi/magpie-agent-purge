import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const { onRequest, purgeHome, stripIdentity, stripFrontmatter } = await import("../hooks.js");

const PERSONA = "Your name is Canary-9f3a. Be terse.";
const HOST = "You are Claude, made by Anthropic.\nUse the Read tool before editing.";
const STRIPPED = "Use the Read tool before editing.";

let home;

function makeHome(state = { persona: "canary", default: { mode: "strict" } }) {
	const dir = mkdtempSync(join(tmpdir(), "magpie-agent-purge-"));
	mkdirSync(join(dir, "personas"), { recursive: true });
	writeFileSync(join(dir, "personas", "canary.md"), ["---", "name: Canary", "---", PERSONA].join("\n"));
	writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, ...state }));
	process.env.AGENT_PURGE_HOME = dir;
	return dir;
}

const ctx = (protocol, options = {}, agent = "claude") => ({ protocol, agent, options, report: () => {} });

const bodies = {
	anthropic: () => ({ system: HOST, messages: [{ role: "user", content: "hi" }] }),
	chat: () => ({ messages: [{ role: "system", content: HOST }, { role: "user", content: "hi" }] }),
	responses: () => ({ instructions: HOST, input: [{ role: "user", content: "hi" }] }),
	gemini: () => ({ systemInstruction: { parts: [{ text: HOST }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
};

const systemOf = {
	anthropic: (b) => (Array.isArray(b.system) ? b.system.map((x) => x.text).join("\n\n") : b.system),
	chat: (b) => b.messages.find((m) => m.role === "system").content,
	responses: (b) => b.instructions,
	gemini: (b) => b.systemInstruction.parts.map((x) => x.text).join("\n\n"),
};

beforeEach(() => {
	home = makeHome();
});

after(() => {
	delete process.env.AGENT_PURGE_HOME;
});

describe("protocol × mode", () => {
	for (const protocol of Object.keys(bodies)) {
		it(`${protocol}: off 原样放行`, async () => {
			const body = bodies[protocol]();
			const before = JSON.stringify(body);
			assert.equal(await onRequest(body, ctx(protocol, { mode: "off" })), undefined);
			assert.equal(JSON.stringify(body), before);
		});

		it(`${protocol}: strict 只留人设`, async () => {
			const body = bodies[protocol]();
			await onRequest(body, ctx(protocol, { mode: "strict" }));
			assert.equal(systemOf[protocol](body), PERSONA);
		});

		it(`${protocol}: append 人设在最前，宿主原样`, async () => {
			const body = bodies[protocol]();
			await onRequest(body, ctx(protocol, { mode: "append" }));
			assert.equal(systemOf[protocol](body), `${PERSONA}\n\n${HOST}`);
		});

		it(`${protocol}: replace 去掉身份句`, async () => {
			const body = bodies[protocol]();
			await onRequest(body, ctx(protocol, { mode: "replace" }));
			assert.equal(systemOf[protocol](body), `${PERSONA}\n\n${STRIPPED}`);
		});

		it(`${protocol}: 默认模式来自 state.json`, async () => {
			const body = bodies[protocol]();
			await onRequest(body, ctx(protocol));
			assert.equal(systemOf[protocol](body), PERSONA);
		});

		it(`${protocol}: agents 白名单之外放行`, async () => {
			const body = bodies[protocol]();
			const before = JSON.stringify(body);
			assert.equal(await onRequest(body, ctx(protocol, { agents: ["codex"] }, "claude")), undefined);
			assert.equal(JSON.stringify(body), before);
		});
	}
});

describe("人设来源", () => {
	it("页面导入的人设优先于同名磁盘文件", async () => {
		writeFileSync(join(home, "personas", "dup.md"), "FROM-DISK");
		const body = bodies.anthropic();
		await onRequest(
			body,
			ctx("anthropic", { mode: "strict", persona: "dup", inlinePersonas: [{ id: "dup", text: "FROM-PAGE" }] }),
		);
		assert.equal(systemOf.anthropic(body), "FROM-PAGE");
	});

	it("导入人设的 frontmatter 会被剥掉", async () => {
		const body = bodies.anthropic();
		await onRequest(
			body,
			ctx("anthropic", {
				mode: "strict",
				persona: "mine",
				inlinePersonas: [{ id: "mine", text: "---\nname: Ignored\n---\nSay only OK." }],
			}),
		);
		assert.equal(systemOf.anthropic(body), "Say only OK.");
	});

	it("options.persona 覆盖 state.persona", async () => {
		writeFileSync(join(home, "personas", "other.md"), "OTHER");
		const body = bodies.anthropic();
		await onRequest(body, ctx("anthropic", { mode: "strict", persona: "other" }));
		assert.equal(systemOf.anthropic(body), "OTHER");
	});

	it("人设文件不存在时放行", async () => {
		const body = bodies.anthropic();
		assert.equal(await onRequest(body, ctx("anthropic", { mode: "strict", persona: "missing" })), undefined);
		assert.equal(body.system, HOST);
	});
});

describe("健壮性", () => {
	it("未知协议放行", async () => {
		const body = { system: "x" };
		assert.equal(await onRequest(body, ctx("cohere", { mode: "strict" })), undefined);
		assert.equal(body.system, "x");
	});

	it("坏 body 不抛异常", async () => {
		assert.equal(await onRequest(null, ctx("anthropic")), undefined);
		assert.equal(await onRequest("junk", ctx("anthropic")), undefined);
		assert.equal(await onRequest([], ctx("anthropic")), undefined);
	});

	it("坏 inlinePersonas 被忽略", async () => {
		for (const inlinePersonas of ["junk", [{ id: 42 }], [{ id: "blank", text: "   " }]]) {
			const body = bodies.anthropic();
			assert.equal(
				await onRequest(body, ctx("anthropic", { mode: "strict", persona: "blank", inlinePersonas })),
				undefined,
			);
			assert.equal(body.system, HOST);
		}
	});

	it("路径穿越 id 不会被拼成文件路径", async () => {
		const body = bodies.anthropic();
		assert.equal(await onRequest(body, ctx("anthropic", { mode: "strict", persona: "../../etc/passwd" })), undefined);
		assert.equal(body.system, HOST);
	});

	it("坏 state.json 按 off 处理", async () => {
		writeFileSync(join(home, "state.json"), "{not json");
		const body = bodies.anthropic();
		assert.equal(await onRequest(body, ctx("anthropic")), undefined);
		assert.equal(body.system, HOST);
	});

	it("anthropic 的 cache_control 块在 append 时保留", async () => {
		const block = { type: "text", text: HOST, cache_control: { type: "ephemeral" } };
		const body = { system: [block] };
		await onRequest(body, ctx("anthropic", { mode: "append" }));
		assert.deepEqual(body.system[1], { type: "text", text: HOST, cache_control: { type: "ephemeral" } });
	});

	it("report 抛错不影响放行", async () => {
		const body = bodies.anthropic();
		const bad = { protocol: "anthropic", options: { mode: "strict" }, report: () => { throw new Error("boom"); } };
		assert.equal(await onRequest(body, bad), body);
	});
});

describe("辅助函数", () => {
	it("stripFrontmatter 只剥开头的块", () => {
		assert.equal(stripFrontmatter("---\na: b\n---\nbody"), "body");
		assert.equal(stripFrontmatter("body\n---\na: b\n---"), "body\n---\na: b\n---");
	});

	it("stripIdentity 只删自称 + 点名的行", () => {
		assert.equal(stripIdentity("You are Claude.\nUse tools."), "Use tools.");
		assert.equal(stripIdentity("You are helpful.\nUse tools."), "You are helpful.\nUse tools.");
	});

	it("purgeHome 支持相对路径与默认值", () => {
		assert.match(purgeHome(""), /\.agent-purge$/);
		assert.equal(purgeHome("/tmp/x"), "/tmp/x");
	});
});