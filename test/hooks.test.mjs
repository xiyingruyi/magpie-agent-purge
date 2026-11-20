import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const { onRequest, purgeHome, resolvePersona, stripIdentity, stripFrontmatter } = await import("../hooks.js");

const PERSONA = "Your name is Canary-9f3a. Be terse.";
const OTHER = "Your name is Otter-1c7e. Answer in one line.";
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

		it(`${protocol}: disabledAgents 排除的 agent 放行`, async () => {
			const body = bodies[protocol]();
			const before = JSON.stringify(body);
			assert.equal(await onRequest(body, ctx(protocol, { disabledAgents: ["claude"] }, "claude")), undefined);
			assert.equal(JSON.stringify(body), before);
		});

		it(`${protocol}: 同时命中 agents 与 disabledAgents 时按排除`, async () => {
			const body = bodies[protocol]();
			const before = JSON.stringify(body);
			const options = { agents: ["claude"], disabledAgents: ["claude"] };
			assert.equal(await onRequest(body, ctx(protocol, options, "claude")), undefined);
			assert.equal(JSON.stringify(body), before);
		});

		it(`${protocol}: 不在 disabledAgents 里的 agent 照常改写`, async () => {
			const body = bodies[protocol]();
			await onRequest(body, ctx(protocol, { mode: "append", disabledAgents: ["codex"] }, "claude"));
			assert.equal(systemOf[protocol](body), `${PERSONA}\n\n${HOST}`);
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
describe("state.json 的停用与分家", () => {
	// 宿主原样 = 这次请求没被人设改写
	it("总暂停优先于 options.mode", async () => {
		home = makeHome({ persona: "canary", default: { mode: "off" }, overrides: { claude: { mode: "append" } } });
		const body = bodies.anthropic();
		assert.equal(await onRequest(body, ctx("anthropic", { mode: "append" })), undefined);
		assert.equal(systemOf.anthropic(body), HOST);
		assert.equal(resolvePersona({ mode: "append" }, home, "claude").blockedBy, "global-pause");
	});

	it("这家自己 off 只放行这一家", async () => {
		home = makeHome({ persona: "canary", default: { mode: "append" }, overrides: { claude: { mode: "off" } } });
		const mine = bodies.anthropic();
		assert.equal(await onRequest(mine, ctx("anthropic")), undefined);
		assert.equal(systemOf.anthropic(mine), HOST);
		assert.equal(resolvePersona({}, home, "claude").blockedBy, "harness-off");

		const other = bodies.anthropic();
		await onRequest(other, ctx("anthropic", {}, "codex"));
		assert.equal(systemOf.anthropic(other), `${PERSONA}\n\n${HOST}`);
	});

	it("disabledHarnesses 停用名单只放行名单里的", async () => {
		home = makeHome({ persona: "canary", default: { mode: "append" }, disabledHarnesses: ["claude"] });
		const mine = bodies.anthropic();
		assert.equal(await onRequest(mine, ctx("anthropic")), undefined);
		assert.equal(systemOf.anthropic(mine), HOST);
		assert.equal(resolvePersona({}, home, "claude").blockedBy, "harness-disabled");

		const other = bodies.anthropic();
		await onRequest(other, ctx("anthropic", {}, "codex"));
		assert.equal(systemOf.anthropic(other), `${PERSONA}\n\n${HOST}`);
	});

	it("overrides 里可以给单家换人设与模式", async () => {
		home = makeHome({ persona: "canary", default: { mode: "append" }, overrides: { claude: { persona: "other", mode: "strict" } } });
		writeFileSync(join(home, "personas", "other.md"), OTHER);

		const mine = bodies.anthropic();
		await onRequest(mine, ctx("anthropic"));
		assert.equal(systemOf.anthropic(mine), OTHER);

		const other = bodies.anthropic();
		await onRequest(other, ctx("anthropic", {}, "codex"));
		assert.equal(systemOf.anthropic(other), `${PERSONA}\n\n${HOST}`);
	});

	it("options.persona 仍然压过 overrides", async () => {
		home = makeHome({ persona: "canary", default: { mode: "append" }, overrides: { claude: { persona: "other" } } });
		writeFileSync(join(home, "personas", "other.md"), OTHER);
		const body = bodies.anthropic();
		await onRequest(body, ctx("anthropic", { persona: "canary" }));
		assert.equal(systemOf.anthropic(body), `${PERSONA}\n\n${HOST}`);
	});

	it("缺 default.mode 按 replace 兜底", async () => {
		home = makeHome({ persona: "canary" });
		assert.equal(resolvePersona({}, home, "claude").mode, "replace");
		const body = bodies.anthropic();
		await onRequest(body, ctx("anthropic"));
		assert.equal(systemOf.anthropic(body), `${PERSONA}\n\n${STRIPPED}`);
	});
});

describe("插件自带的人设", () => {
	it("磁盘没有该人设时用插件自带的", () => {
		home = makeHome(); // personas/ 里只有 canary.md
		const r = resolvePersona({ persona: "neutral" }, home, "claude");
		assert.equal(r.source, "bundled");
		assert.ok(r.text.length > 0);
		assert.ok(!r.text.startsWith("---"), "frontmatter 不进 prompt");
	});

	it("磁盘上的人设压过自带的", () => {
		home = makeHome();
		writeFileSync(join(home, "personas", "neutral.md"), "Custom neutral body.");
		const r = resolvePersona({ persona: "neutral" }, home, "claude");
		assert.equal(r.source, "disk");
		assert.equal(r.text, "Custom neutral body.");
	});

	it("谁都没有就什么都不注入", () => {
		home = makeHome();
		const r = resolvePersona({ persona: "nobody" }, home, "claude");
		assert.equal(r.source, "none");
		assert.equal(r.text, "");
	});
});
