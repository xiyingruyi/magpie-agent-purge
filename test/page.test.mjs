// 假 DOM + 假 magpie，直接跑真实的 page/app.js。
// 真页面跑在 magpie 沙箱里，这里只验逻辑：初始渲染、选择落盘、agents 解析、
// 导入 / 删除、保存失败回滚，以及未知 options 键不被写没。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const appSrc = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../page/app.js"), "utf8");

class Node {
	constructor(tag = "div") {
		this.tag = tag;
		this.children = [];
		this.dataset = {};
		this.attrs = {};
		this.className = "";
		this.value = "";
		this.title = "";
		this.type = "";
		this.hidden = false;
		this.focused = false;
		this._text = "";
	}
	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}
	get textContent() {
		return this._text;
	}
	append(...kids) {
		this.children.push(...kids);
	}
	setAttribute(key, value) {
		this.attrs[key] = String(value);
	}
	focus() {
		this.focused = true;
	}
}

const IDS = [
	"now-persona",
	"now-mode",
	"mode",
	"agents",
	"q",
	"list",
	"count",
	"status",
	"file",
	"body",
	"pid",
	"pname",
	"import-save",
	"import-reset",
	"import-count",
	"import-err",
];
const nodes = Object.fromEntries(IDS.map((id) => [id, new Node()]));
nodes.status.hidden = true;
nodes["import-err"].hidden = true;
const document = { getElementById: (id) => nodes[id], createElement: (tag) => new Node(tag) };

class Option {
	constructor(text, value) {
		this.text = text;
		this.value = value;
	}
}

const realSetTimeout = globalThis.setTimeout;
let clock = 1_000_000;
const fakeSetTimeout = (fn) => {
	clock += 5000;
	queueMicrotask(fn);
	return 0;
};

const PERSONAS = [
	{ id: "terse", name: "极简", description: "只回答，不解释" },
	{ id: "neutral", name: "中性助手", description: "最小身份" },
];
const window = { PERSONAS };

const calls = [];
let store = { persona: "terse", mode: "append", agents: ["claude"], custom: "keep" };
let failNext = false;
const magpie = {
	ready: Promise.resolve(),
	options: {
		async get() {
			return { ...store };
		},
		async set(options) {
			calls.push({ ...options });
			if (failNext) {
				failNext = false;
				throw new Error("boom");
			}
			store = { ...options };
			return { ...store };
		},
	},
};

const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0));
const settle = async () => {
	for (let i = 0; i < 20; i++) await tick();
};
const textOf = (node) => (node._text ?? "") + (node.children ?? []).map(textOf).join(" ");
const all = (node) => [node, ...(node.children ?? []).flatMap(all)];
const personaButton = (id) => all(nodes.list).find((n) => n.dataset?.persona === id);
const rowOf = (id) => all(nodes.list).find((n) => n.className?.startsWith("persona") && all(n).some((c) => c.dataset?.persona === id));

const ok = (condition, message) => {
	if (!condition) {
		console.error(`✗ ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${message}`);
	}
};

runInNewContext(appSrc, {
	magpie,
	window,
	document,
	Option,
	setTimeout: fakeSetTimeout,
	Date: { now: () => clock },
	queueMicrotask,
	Promise,
});
await settle();

ok(nodes["now-persona"].textContent === "极简", "初始状态显示当前人设");
ok(nodes.mode.value === "append", "初始模式来自 options");
ok(nodes.agents.value === "claude", "初始 agents 显示为逗号分隔");
ok(all(nodes.list).filter((n) => n.className === "persona" || n.className === "persona on").length === 2, "列出两个人设");
ok(textOf(nodes.count).includes("全部 2"), "计数显示全部 2");

// 点选另一个人设：落盘、保留 agents 与未知键
personaButton("neutral").onclick();
await settle();
ok(store.persona === "neutral", "点选后 persona 落盘");
ok(JSON.stringify(store.agents) === '["claude"]', "agents 未被写没");
ok(store.custom === "keep", "未知 options 键被保留");
ok(textOf(nodes["now-persona"]) === "中性助手", "当前人设立刻更新");

// agents 输入解析
nodes.agents.value = "claude, codex";
nodes.agents.onchange({ target: { value: "claude, codex" } });
await settle();
ok(JSON.stringify(store.agents) === '["claude","codex"]', "agents 输入按逗号解析");

// 导入 md
nodes.body.value = "---\nname: Mine\n---\nSay only OK.";
nodes.pid.value = "mine";
nodes.pname.value = "";
nodes["import-save"].onclick();
await settle();
ok(store.inlinePersonas?.length === 1 && store.inlinePersonas[0].id === "mine", "导入的人设写入 inlinePersonas");
ok(store.inlinePersonas[0].text.includes("Say only OK."), "导入正文完整保存");
ok(store.persona === "mine", "导入即选中");
ok(textOf(nodes["import-count"]).includes("已导入 1"), "导入计数更新");

// 删除导入
const row = rowOf("mine");
const del = all(row).find((n) => n.className === "del");
del.onclick();
await settle();
ok((store.inlinePersonas ?? []).length === 0, "删除后 inlinePersonas 清空");
ok(store.persona === "", "删除选中的人设后回到跟随");

// 保存失败回滚
failNext = true;
personaButton("terse").onclick();
await settle();
ok(textOf(nodes.status).includes("保存失败"), "保存失败时状态报错");
ok(nodes.status.dataset.state === "error", "状态标记为 error");

console.log("page ok");