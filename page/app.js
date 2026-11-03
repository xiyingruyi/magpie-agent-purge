// 人设页：只负责把人设 id、模式、agent 白名单写进本插件的 options。
// 真正改写请求的是 hooks.js。沙箱页是 classic script，所以整段包在 async IIFE 里。
(async () => {
	await magpie.ready;

	const MODES = [
		["", "跟随 agent-purge（state.json）"],
		["strict", "strict — 只发人设，宿主 system 全丢"],
		["replace", "replace — 人设 + 宿主去掉身份句"],
		["append", "append — 人设在前，宿主原样保留"],
		["off", "off — 不注入"],
	];
	// magpie.options.set 每秒只收一次；两次调用之间必须留够间隔
	const RATE_MS = 1000;

	const $ = (id) => document.getElementById(id);

	let base = {}; // 服务端已知的完整 options：页面不管的键原样带回去
	let picked = { persona: "", mode: "", agents: [] };
	let focusedId = ""; // 重绘时把焦点还给同一个按钮
	let sent = "";
	let sending = false;
	let lastAt = 0;
	let failed = "";

	const fixed = () => (Array.isArray(window.PERSONAS) ? window.PERSONAS : []);
	const inline = () => (Array.isArray(base.inlinePersonas) ? base.inlinePersonas : []);
	const rows = () => [
		...inline().map((p) => ({ id: p.id, name: p.name || p.id, description: "页面导入", imported: true })),
		...fixed().map((p) => ({ ...p, imported: false })),
	];
	const nameOf = (id) => rows().find((p) => p.id === id)?.name || id;
	const pickKey = () => JSON.stringify([picked.persona, picked.mode, picked.agents, inline()]);
	const modeText = (mode) =>
		mode === "" ? "跟随 state.json" : MODES.find(([value]) => value === mode)?.[1]?.split(" — ")[0] || mode;

	function paintStatus() {
		const status = $("status");
		status.hidden = false;
		status.dataset.state = failed ? "error" : sending ? "busy" : "ok";
		status.textContent = failed
			? failed
			: sending
				? "正在保存…"
				: `已保存：${picked.persona ? nameOf(picked.persona) : "跟随 state.json"} · ${modeText(picked.mode)}${
						picked.agents.length ? ` · 仅 ${picked.agents.join(" / ")}` : ""
					}`;
	}

	function paint() {
		$("now-persona").textContent = picked.persona ? nameOf(picked.persona) : "跟随 state.json";
		$("now-mode").textContent = modeText(picked.mode);
		$("mode").value = picked.mode;
		$("agents").value = picked.agents.join(", ");

		const query = $("q").value.trim().toLowerCase();
		const hits = rows().filter(
			(p) => !query || [p.id, p.name, p.description].some((s) => String(s ?? "").toLowerCase().includes(query)),
		);

		$("count").textContent = query ? `匹配 ${hits.length} / ${rows().length}` : `全部 ${rows().length}`;
		const list = $("list");
		list.textContent = "";
		if (!hits.length) {
			const empty = document.createElement("p");
			empty.className = "empty";
			empty.textContent = rows().length
				? "没有匹配的人设"
				: "人设清单是空的：先跑 npm run gen:personas，或在下面导入一个 md";
			list.append(empty);
			paintStatus();
			return;
		}

		let refocus = null;
		for (const item of hits) {
			const row = document.createElement("div");
			row.className = item.id === picked.persona ? "persona on" : "persona";

			const pick = document.createElement("button");
			pick.type = "button";
			pick.className = "pick";
			pick.dataset.persona = item.id;
			pick.setAttribute("aria-pressed", item.id === picked.persona ? "true" : "false");
			pick.title = item.description || item.id;
			if (item.id === focusedId) refocus = pick;

			const name = document.createElement("strong");
			name.textContent = (item.id === picked.persona ? "✓ " : "") + (item.name || item.id);
			pick.append(name);

			if (item.description) {
				const desc = document.createElement("span");
				desc.textContent = item.description;
				pick.append(desc);
			}
			if (item.id !== (item.name || item.id)) {
				const code = document.createElement("code");
				code.textContent = item.id;
				pick.append(code);
			}
			pick.onclick = () => {
				focusedId = item.id;
				save({ persona: item.id });
			};
			row.append(pick);

			if (item.imported) {
				const del = document.createElement("button");
				del.type = "button";
				del.className = "del";
				del.textContent = "删除";
				del.title = `删除导入的人设 ${item.id}`;
				del.onclick = () => {
					base = {
						...base,
						inlinePersonas: inline().filter((p) => p.id !== item.id),
					};
					if (picked.persona === item.id) picked = { ...picked, persona: "" };
					paintImport();
					paint();
					void flush();
				};
				row.append(del);
			}
			list.append(row);
		}
		if (refocus) refocus.focus();
		paintStatus();
	}

	function save(patch) {
		failed = "";
		picked = { ...picked, ...patch };
		paint();
		void flush();
	}

	// 串行化 + 合并：点击期间不丢，最终以最后一次选择为准
	async function flush() {
		if (sending) return;
		sending = true;
		paintStatus();
		try {
			while (sent !== pickKey()) {
				const key = pickKey();
				const body = {
					...base,
					persona: picked.persona,
					mode: picked.mode,
					agents: picked.agents,
				};
				const wait = Math.max(0, RATE_MS + 50 - (Date.now() - lastAt));
				if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
				lastAt = Date.now();

				let saved = body;
				try {
					// set 返回保存后的完整 options，以它为准（magpie 可能补默认值）
					saved = (await magpie.options.set(body)) ?? body;
				} catch (error) {
					failed = `保存失败：${error?.message ?? error}`;
					picked = {
						persona: base.persona ?? "",
						mode: base.mode ?? "",
						agents: Array.isArray(base.agents) ? base.agents : [],
					};
					paint();
					return;
				}
				base = typeof saved === "object" && saved ? { ...body, ...saved } : body;
				sent = key;
				paint();
			}
		} finally {
			sending = false;
			paintStatus();
		}
	}

	for (const [value, text] of MODES) $("mode").append(new Option(text, value));

	// 先拿到完整 options 再开放交互，否则这期间的点击会拿空 base 组 body，把别的键写没
	try {
		base = (await magpie.options.get()) ?? {};
	} catch (error) {
		$("status").hidden = false;
		$("status").dataset.state = "error";
		$("status").textContent = `读不到当前 options：${error?.message ?? error}`;
		return;
	}
	picked = {
		persona: typeof base.persona === "string" ? base.persona : "",
		mode: typeof base.mode === "string" ? base.mode : "",
		agents: Array.isArray(base.agents) ? base.agents.filter((a) => typeof a === "string") : [],
	};
	sent = pickKey();
	paint();

	$("mode").onchange = (event) => save({ mode: event.target.value });
	$("agents").onchange = (event) =>
		save({ agents: event.target.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) });
	$("q").oninput = () => paint();

	// —— 导入人设 md ——
	// 沙箱页没有 fs、没有 fetch：原生 file input + File.text() 是读用户主动选的文件的唯一通道。
	const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
	const MAX_TEXT = 64 * 1024; // options 是整份读写的 JSON
	const MAX_COUNT = 30;
	const metaOf = (raw) => {
		const out = { name: "", description: "" };
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
		if (!match) return out;
		for (const line of match[1].split(/\r?\n/)) {
			const kv = /^\s*(name|title|description)\s*:\s*(.+)$/i.exec(line);
			if (kv) out[kv[1].toLowerCase() === "description" ? "description" : "name"] = kv[2].trim().replace(/^["']|["']$/g, "");
		}
		return out;
	};
	const importError = (message) => {
		const element = $("import-err");
		element.hidden = !message;
		element.dataset.state = message ? "error" : "";
		element.textContent = message || "";
	};
	const resetForm = () => {
		importError("");
		$("body").value = "";
		$("pid").value = "";
		$("pname").value = "";
		$("file").value = "";
	};
	const paintImport = () => {
		$("import-count").textContent = inline().length ? `已导入 ${inline().length} 个` : "还没有导入";
	};

	$("file").onchange = async (event) => {
		const file = event.target.files?.[0];
		if (!file) return;
		let raw = "";
		try {
			raw = await file.text();
		} catch (error) {
			importError(`读不了这个文件：${error?.message ?? error}`);
			return;
		}
		importError("");
		$("body").value = raw;
		const meta = metaOf(raw);
		if (meta.name) $("pname").value = meta.name;
		if (!$("pid").value.trim()) {
			const guess = String(file.name ?? "")
				.replace(/\.(md|markdown|txt)$/i, "")
				.replace(/[^A-Za-z0-9._-]+/g, "-")
				.replace(/^[^A-Za-z0-9]+/, "")
				.slice(0, 64);
			if (guess) $("pid").value = guess;
		}
	};

	$("import-save").onclick = () => {
		const text = $("body").value.trim();
		const id = $("pid").value.trim();
		if (!text) return importError("正文是空的：先选一个 .md 文件，或者把正文贴进来。");
		if (text.length > MAX_TEXT) return importError(`正文 ${text.length} 字，超过 ${MAX_TEXT / 1024}KB 上限。`);
		if (!ID_RE.test(id)) return importError("id 只能用字母、数字、点、下划线、连字符，并以字母或数字开头（例：my-persona）。");
		if (fixed().some((p) => p.id === id)) return importError(`id「${id}」和磁盘人设重名，换一个。`);
		if (inline().length >= MAX_COUNT && !inline().some((p) => p.id === id)) {
			return importError(`最多 ${MAX_COUNT} 个导入人设：先删掉一些再导入。`);
		}
		const name = $("pname").value.trim() || metaOf(text).name || id;
		base = {
			...base,
			inlinePersonas: [...inline().filter((p) => p.id !== id), { id, name, text }],
		};
		resetForm();
		paintImport();
		save({ persona: id }); // 导入即选中
	};

	$("import-reset").onclick = () => resetForm();

	paintImport();
})();