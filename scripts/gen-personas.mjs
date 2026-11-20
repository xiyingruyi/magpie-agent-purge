// 生成页面用的人设清单：沙箱页读不到磁盘，也发不出 fetch，
// 清单只能静态带进页面。默认写 page/personas.js，它随插件一起走仓库；
// 不想进仓库的用 `npm run gen:personas -- --local`，写 page/personas.local.js，
// 页面会把它叠在仓库清单之上（同 id 以本地为准，已在 .gitignore 里）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const env = process.env.AGENT_PURGE_HOME?.trim();
const home = !env ? join(homedir(), ".agent-purge") : isAbsolute(env) ? env : resolve(env);
const dir = join(home, "personas");

if (!existsSync(dir)) {
	console.error(`找不到人设目录：${dir}`);
	console.error("先运行一次 agent-purge（或 agent-purge ls）生成 personas。");
	process.exit(1);
}

const field = (frontmatter, key) =>
	frontmatter
		.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]
		?.trim()
		.replace(/^["']|["']$/g, "") ?? "";

const list = readdirSync(dir)
	.filter((file) => file.endsWith(".md") && file !== "active.md") // active.md 是同步副本，不是可选人设
	.map((file) => {
		const frontmatter = readFileSync(join(dir, file), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
		return {
			id: field(frontmatter, "id") || file.replace(/\.md$/, ""),
			name: field(frontmatter, "name"),
			description: field(frontmatter, "description"),
		};
	})
	.sort((a, b) => a.id.localeCompare(b.id));

// 往前 ./page/personas.js 或 ./page/personas.local.js 里写
const local = process.argv.includes("--local");
const target = new URL(`../page/personas${local ? ".local" : ""}.js`, import.meta.url);
writeFileSync(
	target,
	local
		? `window.PERSONAS_LOCAL = ${JSON.stringify(list, null, "\t")};\n`
		: `window.PERSONAS = ${JSON.stringify(list, null, "\t")};\n`,
);
console.log(`${local ? "personas.local.js" : "personas.js"} ← ${list.length} 个：${list.map((p) => p.id).join(", ")}`);