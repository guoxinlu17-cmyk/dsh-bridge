# DSH Bridge

[中文](README.md) ｜ **English**

> Bring [DeepSeek Harness](https://github.com/deepseek-ai) into Zotero: right-click a paper to ask about it, select text in the reader to ask about that, and save the answer straight back as a Zotero note.

[![Zotero](https://img.shields.io/badge/Zotero-9.0.6%20tested-CC2936)](https://www.zotero.org)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-4B6BFB)](#requirements)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What problem does this solve

Zotero's plugin market has over a hundred plugins that let you "chat with your papers", and they share one design decision: **each brings its own model**.

Which means the context you have accumulated inside Zotero — your library, annotations, notes, knowledge base, retrieval toolchain — **cannot reach them**, and neither can the tools you have already configured elsewhere.

DSH Bridge inverts the direction: **Zotero is just the entry point, and the work happens in the DSH you already run locally.** Everything your `dsh` can do — knowledge-base search, literature search, citation tooling, file access, Obsidian writes — is available from this dialog.

```
Select a paper in Zotero ──┐
Select text in the reader ─┼──→ dsh --profile <yours> --json -  ──→ answer back in Zotero
A preset from the menu ────┘          (inherits all its plugins and tools)
```

## Features

**Conversation**
- Standalone window: Markdown rendering, streaming output, per-message actions (copy / regenerate / edit-and-resend / delete)
- Quick-action cards (sharing the same preset list as the context menu, instead of hiding in a menu)
- **Materials panel**: how many characters each item contributed, and whether a length cap truncated it
- **Citation checking**: every quote in an answer is traced back to **the text actually sent to the model**, and labelled
  `verbatim` / `near N%` / **`not found in these materials`** — click a row to locate the source in Zotero
- Session history: a left-hand list; click one to restore the conversation and **continue the same DSH session**

**Write-back to Zotero**
- Save as a note (title generated from content; or press "AI title" to have the model shorten it)
- Group the current materials into a collection in one click
- Click a materials row to locate it in the main window

**Reader**
- Selection popup: ask / explain / critique
- Toolbar button and annotation-sidebar entry

**Other**
- Workspace dropdown: the chosen directory becomes the child process `cwd`
- Sessions are auto-registered into a DSH workspace so they show up in the DSH UI
- Settings pane: 13 options plus "Test connection"
- Serialization gate: at most one DSH child process at a time, the rest queue FIFO

## Requirements

| Dependency | Notes |
| --- | --- |
| **Zotero** | 7+ (developed and tested on **9.0.6**) |
| **DeepSeek Harness** | Verified on `0.2.1-rc.2`; needs `node` and the path to `dsh`'s `bin.js` |
| **A dedicated DSH profile** | Best created from `headless`, then add the plugins you want (see below) |

> ⚠️ **Do not point this at a bare `headless` profile** — it has no plugins at all, so the session has no `kb_search`, `lit_search`, or anything else.
> ```bash
> dsh dshbridge --from-default-profile headless --dump-config
> dsh plugin --profile dshbridge add dsh-kb-rag dsh-lit-search dsh-cite dsh-zotero dsh-obsidian
> ```
> And **make sure the credentials service is enabled in that profile** — otherwise you will get `MISSING_CREDENTIAL` (see *Known limitations*).

## Install

1. Download `dsh-bridge-<version>.xpi`
2. Zotero → `Tools → Add-ons → gear → Install Add-on From File…`
3. Restart Zotero

## First-run configuration

`Edit → Settings → DSH Bridge`, fill in four fields, then press **Test connection**:

| Field | Example |
| --- | --- |
| `node.exe` path | `C:\Program Files\nodejs\node.exe` |
| `dsh`'s `bin.js` | `…\npm\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| DSH profile | `dshbridge` |
| Conversation workspace | `D:\your-project` (empty = run in Zotero's own directory) |

> "Test connection" runs `node <bin> --profile <p> --dump-config`: **it does not call the model**, so it returns in seconds. It proves *the configuration loads* — **not** that the model will answer.

## Known limitations (read this first)

Stated plainly, because each one was paid for in debugging:

| Limitation | Explanation |
| --- | --- |
| **No reader sidebar** | In Zotero 9.0.6 the reader window contains a single nested `<browser>`, and the sidebar is built in — **there is no third-party registration point**. Only 8 event types can be injected (3 of which may render DOM). So this project uses a **toolbar button plus a selection popup**, not a persistent sidebar. |
| **`renderSidebar` is not a valid event** | Some write-ups use it to inject into the reader — it **fails silently** (no error, no output). |
| **A registered session needs a DSH restart to appear** | DSH reads the workspace registry into memory **at boot** and does not watch the file; all a plugin can do is rewrite the file. |
| **Credentials must be enabled in the profile** | If `dsh --profile <p> --json -` reports `MISSING_CREDENTIAL`, that profile has `dsh-credentials-local` disabled. Add `- id: credentials` / `disabled: false` to `~/.dsh/profiles/<p>/cordis.patch.yml`. |
| **A DSH upgrade can break it** | Version exemptions and bundle defaults can change between releases. After upgrading, run `--dump-config` once and look for `skipping profile bundle`. |

**Not yet verified in a real environment** (stated as of release): the "Group materials" button, some dark-theme details, and settings-pane rendering on certain Zotero versions.

## Implementation notes

- **A single `bootstrap.js`** — not laziness. `Services.scriptloader.loadSubScript(url, ctx)` was measured to **hang with no catchable exception** on this machine, so everything outside the rendering layer lives in the bootstrap scope.
- **Security**: answer text is **untrusted**. Rendering goes through DOM construction (`createElementNS` + `textContent`); **`innerHTML` is used nowhere in this repository**. Notes are written via `MD.toHTML()` (hand-rolled escaping), and links are limited to `http`/`https`/`mailto`.
- **Testable**: the Markdown tokenizer and the citation matcher are **pure functions** (`content/markdown.js`, `content/cite.js`), so they run directly under node.

## Development

```bash
node tests/md-tokenizer.test.mjs      # 30 assertions
```

Packaging: zip `manifest.json / bootstrap.js / prefs.js / content/*`, rename to `.xpi` (`manifest.json` must be at the archive root).

## License

MIT. See [LICENSE](LICENSE).
