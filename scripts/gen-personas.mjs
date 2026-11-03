// 生成 page/personas.js：沙箱页读不到磁盘，也发不出 fetch，
// 人设清单只能静态带进页面。增删人设后重跑一次：
//   npm run gen:personas
// 产物只属于本地；仓库里的 personas.js 是空清单。
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

writeFileSync(
	new URL("../page/personas.js", import.meta.url),
	`window.PERSONAS = ${JSON.stringify(list, null, "\t")};\n`,
);
console.log(`personas.js ← ${list.length} 个：${list.map((p) => p.id).join(", ")}`);