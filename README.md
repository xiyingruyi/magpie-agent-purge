# magpie-agent-purge

magpie 网关插件：让 [agent-purge](https://github.com/ZiChuanLan/agent-purge) 的人设与模式作用到**所有经过 magpie 网关的 agent 请求**上。

一份人设，多种入口。Claude Code、Codex、OpenCode、pi……只要请求走 magpie，system 段就按当前人设改写；在 agent-purge 里换人设，下一个请求就生效，不用重装插件、不用重启。

**插件入口是仓库根目录**（`package.json` 的 `magpie.hooks`）。它不依赖 agent-purge 的 npm 包，只读它的数据目录。

## 安装

```bash
magpie plugin add https://github.com/xiyingruyi/magpie-agent-purge
magpie plugin list
```

页面上的内置人设清单来自本地生成（插件页读不到磁盘）：

```bash
cd ~/.config/magpie/plugins/node_modules/magpie-agent-purge
npm run gen:personas
```

装完默认是 `off`：在插件页选人设和模式，或显式写入 options。

## 配置

```bash
magpie plugin options magpie-agent-purge '{"mode":"append","persona":"neutral","agents":["claude","codex"]}'
```

| 字段 | 用途 |
|---|---|
| `mode` | `off` / `strict` / `replace` / `append`；不给则跟随 `state.json` |
| `persona` | 人设 id；不给则跟随 `state.json` 的 `persona` |
| `agents` | 只对这些 magpie agent 生效，例如 `["claude","codex"]`；空数组 = 全部 |
| `inlinePersonas` | 插件页导入的人设 `[{id,name,text}]`；与磁盘同名时以它为准 |

## 四种模式

| 模式 | 行为 | 注意 |
|---|---|---|
| `off` | 不动请求 | 默认 |
| `strict` | 整段 system 换成人设 | 宿主原有的工具说明也会消失，harness 可能变笨 |
| `replace` | 人设在最前，宿主 system 去掉「自称 + 点名模型/厂商」的行 | 身份识别是近似的 |
| `append` | 人设在最前，宿主 system 原样保留 | 不替换身份，注意规则冲突 |

`strict` 不等于「模型只收到人设」：宿主仍可能从别处附加文本。

## 数据与人设文件

插件读 `~/.agent-purge/`（可用 `AGENT_PURGE_HOME` 改，相对路径按当前工作目录解析）：

```
state.json            { "persona": "<id>", "default": { "mode": "append" } }
personas/<id>.md      frontmatter + 正文；只有正文进 prompt
```

人设示例：

```markdown
---
id: concise
name: 简洁协作
description: 中文、先结论、修改前先读代码
---

用简体中文协作。先给结论，再给依据。
修改代码前先阅读现有实现；不确定时明确说明。
```

## 支持的协议

| `ctx.protocol` | system 落点 |
|---|---|
| `anthropic` | `body.system`（字符串或 text 块数组，保留 `cache_control`） |
| `chat` | `messages` 里的 `system` / `developer` 消息 |
| `responses` | `body.instructions` |
| `gemini` | `systemInstruction.parts` / `system_instruction.parts` |

不认识的协议、坏人设、坏请求体一律 **fail-open**：原样放行，不把 agent 的请求弄挂。

## 边界

- 只处理经过 magpie 网关的请求；直连厂商、不经过网关的流量不受影响。
- 插件页没有文件系统和网络，人设清单靠 `gen:personas` 静态生成；导入的人设存在插件 options 里。
- `strict` 移除的是 system 文本，不等于清空独立的结构化工具定义。
- 请求改写在网关侧完成，无法修改客户端已经固定的行为。

## 开发

```bash
npm test        # node:test，四种协议 × 四种模式 + 健壮性
npm run check   # 语法检查
npm run gen:personas
```

不需要 magpie 就能跑 hook 测试：测试喂假的请求体和 ctx。

## 许可

MIT。网关 hook 的设计与协议落点改编自 [ZiChuanLan/agent-purge](https://github.com/ZiChuanLan/agent-purge) 的 `magpie-plugin`（MIT）；详见 [NOTICE](NOTICE)。