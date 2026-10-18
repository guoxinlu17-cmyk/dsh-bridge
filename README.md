# DSH Bridge

> 把 [DeepSeek Harness](https://github.com/deepseek-ai) 接进 Zotero：在文献上右键提问、在阅读器里划词提问，回答直接落成 Zotero 笔记。

[![Zotero](https://img.shields.io/badge/Zotero-9.0.6%20tested-CC2936)](https://www.zotero.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4B6BFB)](#前置要求)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**English** — Zotero's plugin market has 100+ AI plugins, and each of them brings its own model. This one brings *yours*: it drives your local [DeepSeek Harness](https://github.com/deepseek-ai) through `dsh --profile <name> --json -`, so everything your `dsh` can do — your knowledge base, literature search, citation tools, file access — is available from a Zotero dialog. Answers can be checked citation-by-citation against the exact text that was sent to the model, and saved back as Zotero notes. Requires Zotero 7+ (tested on 9.0.6) and a working `dsh` install. **See [已知限制](#已知限制请先读这一段) for what it deliberately cannot do.**

---

## 它解决什么问题

Zotero 的 AI 插件市场里有一百多个"在 Zotero 里和文献对话"的插件，但它们有个共同点：**各自接自己的模型**。

那意味着你在 Zotero 里攒下的上下文（文献库、批注、笔记、知识库、检索工具链）**进不了这些插件**，你也用不上自己在别处配好的工具。

DSH Bridge 换个方向：**Zotero 只是入口，干活的是你本机的 DSH**。
所以 `dsh` 能用的东西——你的知识库检索、文献检索、引文工具、文件读写、Obsidian 写入——在这个对话框里全都能用。

```
Zotero 里选中文献 ──┐
阅读器里划词 ──────┼──→ dsh --profile <你的> --json -  ──→ 回答回到 Zotero
右键菜单预设动作 ──┘        （继承它的全部插件与工具）
```

## 功能

**对话**
- 独立窗口：Markdown 渲染、流式输出、消息级操作（复制/重答/改后再发/删除）
- 快捷动作卡片（与右键菜单共用同一份预设，不再藏在菜单里）
- **材料面板**：逐条显示每篇文献带了多少字、是否被长度上限截掉
- **引文核对**：把回答里的引文回溯到**本次真正发给模型的正文**，逐条标
  `原文一致` / `近似 N%` / **`未在本次材料中找到`**——点一行即在 Zotero 中定位来源
- 会话历史：左侧列表，点一条铺回对话并**接着原 DSH 会话**继续

**写回 Zotero**
- 存为笔记（标题按内容生成；可再点「AI 起标题」让模型起一个更短的）
- 把本次材料一键归到指定集合
- 材料行点一下即在主窗口定位

**阅读器**
- 划词浮层：问 DSH / 解释 / 批判
- 工具栏按钮、批注侧栏入口

**其它**
- 工作区下拉：选哪个，会话就跑在哪个目录（= 子进程 cwd）
- 会话自动登记进 DSH 的工作区，使它在 DSH 界面里可见
- 设置面板：13 项 + 「测试连接」
- 串行闸门：任何时刻只有一个 DSH 子进程，其余 FIFO 排队

## 前置要求

| 依赖 | 说明 |
| --- | --- |
| **Zotero** | 7+（本项目在 **9.0.6** 上开发与实测） |
| **DeepSeek Harness** | 已在 `0.2.1-rc.2` 上验证；需要 `node` 与 `dsh` 的 `bin.js` 路径 |
| **一个专用 DSH profile** | 建议从 `headless` 建一个，再装你要用的插件（见下） |

> ⚠️ **别直接用 `headless` profile**：它一个插件都没装，会话里没有 `kb_search` / `lit_search` 之类任何工具。
> ```bash
> dsh dshbridge --from-default-profile headless --dump-config
> dsh plugin --profile dshbridge add dsh-kb-rag dsh-lit-search dsh-cite dsh-zotero dsh-obsidian
> ```
> 并且**确认该 profile 的凭据服务是开着的**——否则会报 `MISSING_CREDENTIAL`（详见「已知限制」）。

## 安装

1. 下载 `dsh-bridge-<版本>.xpi`
2. Zotero → `工具 → 插件 → 齿轮 → Install Add-on From File…`
3. 重启 Zotero

## 首次配置

`编辑 → 设置 → DSH Bridge`，填四项，然后点 **测试连接**：

| 项 | 例 |
| --- | --- |
| `node.exe` 路径 | `C:\Program Files\nodejs\node.exe` |
| dsh 的 `bin.js` | `…\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| DSH profile | `dshbridge` |
| 对话工作区 | `D:\你的项目`（留空 = 跑在 Zotero 自己的目录） |

> 「测试连接」跑的是 `node <bin> --profile <p> --dump-config`：**不调模型**，几秒返回。它验的是"配置能加载"，**不验"模型能回话"**。

## 已知限制（请先读这一段）

写得直白，因为这些都是实测踩出来的：

| 限制 | 说明 |
| --- | --- |
| **阅读器侧栏做不了** | Zotero 9.0.6 的阅读器窗口只有一个嵌套 `<browser>`，侧栏是内建的、**没有第三方注册点**。能注入的只有 8 种事件（其中 3 种可渲染 DOM）。所以本项目用的是**工具栏按钮 + 划词浮层**，不是常驻侧栏。 |
| **`renderSidebar` 不是合法事件** | 网上有些写法用它在阅读器里挂东西——那会**静默失败**（不报错也不出东西）。 |
| **会话登记后，DSH 界面要重启才看得见** | DSH 在**启动时**把工作区表读进内存，之后不监视文件；插件能做的只有改文件。 |
| **凭据要在 profile 里启用** | 如果 `dsh --profile <p> --json -` 报 `MISSING_CREDENTIAL`，说明该 profile 的 `dsh-credentials-local` 被禁用了。在 `~/.dsh/profiles/<p>/cordis.patch.yml` 里加 `- id: credentials` / `disabled: false`。 |
| **DSH 升级后可能失效** | 版本豁免、bundle 默认值都可能随升级而变。升级后请跑一次 `--dump-config` 看有没有 `skipping profile bundle`。 |

**尚未在真实环境验证的部分**（发布时如实注明）：「建集合」按钮、部分深色主题细节、设置面板在个别 Zotero 版本上的渲染。

## 实现说明

- **单文件 `bootstrap.js`**：不是偷懒。Zotero 的 `Services.scriptloader.loadSubScript(url, ctx)` 在本机实测会**卡住且 catch 不到异常**，所以渲染层之外的全部逻辑都放在 bootstrap 作用域里。
- **安全**：回答内容是**不可信文本**。渲染走 DOM 构造（`createElementNS` + `textContent`），**全仓库不使用 `innerHTML`**；写进 Zotero 笔记时走 `MD.toHTML()`（自建转义），链接只放行 `http/https/mailto`。
- **可测**：Markdown 词法器与引文匹配器是**纯函数**（`content/markdown.js`、`content/cite.js`），可在 node 里直接跑。

## 开发

```bash
node tests/md-tokenizer.test.mjs      # 30 项断言
```

打包：把 `manifest.json / bootstrap.js / prefs.js / content/*` 打成 zip，改后缀为 `.xpi`（`manifest.json` 必须在根目录）。

## 许可

MIT。见 [LICENSE](LICENSE)。
