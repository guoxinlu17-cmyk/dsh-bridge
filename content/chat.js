// DSH Bridge 对话窗口 —— UI 与逻辑
//
// 结构参考 llm-for-zotero（★3289）与 AI Paper Chat：
//   XUL <window> 外壳 + html:div 内容根，UI 由 JS 建 DOM。
// 事件处理基于 `dsh --profile <名> --json` 的 NDJSON 事件流：
//   session / status(step_start|step_end) / thinking / text / final
//   （profile 名取自首选项 extensions.dshbridge.profile，v1.3.0 起默认 dshbridge）

/* eslint-disable no-undef */

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// 窗口侧日志。
// v1.3.1：优先走 bridge.chatLog()——与 bootstrap.js 共用同一份实现、同一个路径首选项
// 和同一套轮转规则；只有当 bridge 还没拿到时（chat.js 刚被解析的那一行）才走下面的兜底。
// 兜底里也读同一个首选项，不再各自硬编码路径。
const LOG_FALLBACK = "";

function chatLogPath() {
  try {
    const p = Zotero.Prefs.get("extensions.dshbridge.logPath", true);
    if (typeof p === "string") return p.trim();
  } catch (e) {}
  return LOG_FALLBACK;
}

function chatLog(msg) {
  // ① 正常路径：交给 bootstrap.js 的 logger
  try {
    const br = (window.DSHChat && window.DSHChat.bridge) || null;
    if (br && typeof br.chatLog === "function") { br.chatLog(msg); return; }
  } catch (e) {}
  // ② 兜底：bridge 尚未就绪
  try {
    const C = (typeof Components !== "undefined") ? Components : null;
    if (!C) return;
    const path = chatLogPath();
    if (!path) return;                    // 首选项留空 = 关闭文件日志
    const f = C.classes["@mozilla.org/file/local;1"].createInstance(C.interfaces.nsIFile);
    f.initWithPath(path);
    const fos = C.classes["@mozilla.org/network/file-output-stream;1"]
      .createInstance(C.interfaces.nsIFileOutputStream);
    fos.init(f, 0x02 | 0x08 | 0x10, parseInt("0666", 8), 0);
    const cos = C.classes["@mozilla.org/intl/converter-output-stream;1"]
      .createInstance(C.interfaces.nsIConverterOutputStream);
    cos.init(fos, "UTF-8");
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    cos.writeString(`[${ts}] [窗口] ${msg}\n`);
    cos.close();
  } catch (e) {}
}

try { chatLog("chat.js 已被解析"); } catch (e) {}

function el(tag, attrs = {}, ...children) {
  const e = document.createElementNS(XHTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") e.setAttribute("class", v);
    else if (k === "text") e.textContent = v;   // 一律 textContent，绝不 innerHTML
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// v1.4.0：把一条消息填进气泡。
// assistant 走 Markdown 渲染（只构造 DOM 节点，绝不 innerHTML）；
// 其余角色保持纯文本（pre-wrap）。渲染失败就退回纯文本，绝不让窗口空白。
function fillBubble(bubble, role, text) {
  const t = text || "";
  if (role === "assistant" && typeof MD !== "undefined" && MD && MD.render) {
    try {
      for (const n of MD.render(document, t)) bubble.appendChild(n);
      bubble.classList.add("md");
      return;
    } catch (e) { chatLog("Markdown 渲染失败，退回纯文本：" + e); }
  }
  bubble.textContent = t;
}

var DSHChat = {
  bridge: null,
  busy: false,
  messages: [],       // {role:'user'|'assistant'|'note'|'error', text}
  sessionId: null,    // dsh 的会话 id —— 有它就能续接多轮
  usage: null,
  lastContext: { n: 0, chars: 0 },
  $bubbles: [],       // v1.3.1：与 messages 同序的气泡元素，供流式增量更新
  matReport: [],      // v1.4.0：材料面板的数据（来自 collectContextDetailed）
  citReport: [],      // v1.7.0：引文核对结果（回答里的引文 → 材料里的出处）
  citOnlyUnmatched: false,   // v1.9.2：只看"未在材料中找到"的（抓编造的用法）
  panelTab: "materials",  // v1.7.0：面板页签，materials | citations
  panelOpen: false,       // 面板是否展开（默认折叠，不挤占消息区）
  lastNoteID: null,       // v1.7.0：最近一次存下的笔记 id（AI 起标题要用）
  regHintShown: false,    // v1.10.0：登记后那句"需重启 DSH"的提示，每个窗口只说一次
  history: { version: 1, sessions: [] },   // v1.8.0：会话历史（落在插件自己的文件里）
  runWorkspace: "",       // v1.9.0：本次运行实际用的工作区（由 runDSH 结果带回）
  sideOpen: false,        // 历史栏是否展开
  $side: null,
  $main: null,
  $ws: null,          // v1.6.0：工作区下拉

  init() {
    chatLog("chat.js 开始 init");
    try {
      const a0 = (window.arguments && window.arguments[0]) || null;
      // 优先用 openDialog 传进来的；拿不到就退回 Zotero.DSHBridge（startup 时挂的全局）
      this.bridge = (a0 && a0.DSHBridge) ? a0.DSHBridge
                  : (a0 || null)
                  || ((typeof Zotero !== "undefined" && Zotero && Zotero.DSHBridge) || null);
      chatLog("bridge = " + (this.bridge ? "有（来源：" +
        ((a0 && a0.DSHBridge) ? "openDialog 参数" : "Zotero.DSHBridge") + "）" : "**没有**"));
      this.buildUI();
      chatLog("buildUI 完成，root 子节点数 = " +
              (document.getElementById("dsh-root")?.childNodes.length ?? "root 不存在"));
      this.loadWorkspaces();      // v1.6.0
      this.loadHistoryFromBridge();   // v1.8.0
      this.render();
      chatLog("render 完成，消息数 = " + this.messages.length);
      if (!this.bridge) {
        this.push("error", "没有拿到 DSHBridge 对象。请重启 Zotero 后重试。");
      }
      this.setStatus("就绪");
      chatLog("init 完成");
      this.$input.focus();
    } catch (e) {
      chatLog("**init 抛出异常**：" + (e && e.stack ? e.stack : e));
    }
  },

  // ---------- 建界面 ----------
  buildUI() {
    const root = document.getElementById("dsh-root");
    if (!root) {
      chatLog("**找不到 #dsh-root 元素**");
      throw new Error("找不到 #dsh-root");
    }
    chatLog("找到 #dsh-root，命名空间=" + root.namespaceURI);

    this.$ctx = el("span", { class: "ctx", text: "未附材料" });
    this.$status = el("span", { class: "status", text: "…" });
    this.$sess = el("span", { class: "sess", text: "新会话" });

    // v1.6.0：工作区下拉 —— 选的是 DSH 子进程的当前目录（已核 dsh 用 process.cwd()）
    this.$ws = el("select", {
      class: "wssel", title: "DSH 会话的工作区（= 子进程的当前目录）",
      onchange: () => this.onWorkspaceChange(),
    });

    const head = el("div", { class: "head" },
      el("span", { class: "brand", text: "DSH 对话" }),
      el("span", { class: "ctxlabel", text: "工作区" }), this.$ws,
      el("span", { class: "spacer" }),
      el("span", { class: "ctxlabel", text: "上下文：" }), this.$ctx,
      el("span", { class: "spacer" }),
      this.$sess,
      el("button", { class: "btn ghost", onclick: () => this.toggleSide(), text: "历史" }),
      el("button", { class: "btn ghost", onclick: () => this.refreshContext(), text: "↻ 刷新选中" }),
      el("button", { class: "btn ghost", onclick: () => this.newSession(), text: "新会话" }),
      el("button", { class: "btn ghost", onclick: () => this.clearAll(), text: "清空" }),
    );

    this.$list = el("div", { class: "list" });

    // v1.4.0：材料面板 —— 放在消息区与工具条之间，默认折叠
    this.$materials = el("div", { class: "materials" });
    this.$materials.hidden = true;

    this.$input = el("textarea", {
      class: "input", rows: "4",
      placeholder: "输入问题…　Ctrl+Enter 发送",
    });
    this.$input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.send(); }
    });
    this.$usectx = el("input", { type: "checkbox" });
    this.$usectx.checked = true;

    this.$send = el("button", { class: "btn primary", onclick: () => this.send(), text: "发送" });
    this.$stop = el("button", { class: "btn", disabled: "disabled", onclick: () => this.abort(), text: "中止" });
    this.$copy = el("button", { class: "btn ghost", onclick: () => this.copyLast(), text: "复制回答" });
    this.$save = el("button", { class: "btn ghost", onclick: () => this.saveToFile(), text: "保存到文件" });

    const tools = el("div", { class: "tools" },
      this.$status,
      el("span", { class: "spacer" }),
      // v1.6.0：三个写回 Zotero 的动作
      el("button", { class: "btn ghost", onclick: () => this.revealMaterials(), text: "在 Zotero 中显示" }),
      el("button", { class: "btn ghost", onclick: () => this.groupMaterials(), text: "建集合" }),
      el("button", { class: "btn ghost", onclick: () => this.saveNote(), text: "存为笔记" }),
      el("button", { class: "btn ghost", onclick: () => this.aiTitle(), text: "AI 起标题" }),
      this.$copy, this.$save,
    );

    const foot = el("div", { class: "foot" },
      el("label", { class: "check" }, this.$usectx,
        el("span", { text: "附带 Zotero 中选中的文献" })),
      el("span", { class: "spacer" }),
      el("span", { class: "hint", text: "Ctrl+Enter 发送" }),
      this.$stop, this.$send,
    );

    root.appendChild(head);
    // v1.8.0：左侧会话历史栏（默认收起）+ 右侧主体
    this.$side = el("div", { class: "side" });
    this.$main = el("div", { class: "main" },
      this.$list,
      this.$materials,
      tools,
      el("div", { class: "composer" }, this.$input, foot));
    root.appendChild(el("div", { class: "bodyrow" }, this.$side, this.$main));
    chatLog("界面已挂载：head/(side+main[list/materials/tools/composer])");
  },

  // ---------- 消息 ----------
  push(role, text) {
    this.messages.push({ role, text: text || "" });
    this.render();
    return this.messages.length - 1;
  },

  // v1.3.1：位置助手。流式输出时，若用户已往上翻看历史，不该把他拽回底部
  // （v1.3.0 的 render() 末尾无条件 scrollTop = scrollHeight）。
  atBottom() {
    const l = this.$list;
    if (!l) return true;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  },

  scrollToEnd() {
    if (this.$list) this.$list.scrollTop = this.$list.scrollHeight;
  },

  /**
   * 更新最后一条消息。
   * @param {string} text
   * @param {boolean} isFinal 收尾时传 true —— 只有那时才渲染 Markdown。
   *   流式期间若每个 chunk 都重排一遍 Markdown，是 O(n²)（和 v1.3.0 重建整棵树同类的问题）；
   *   所以流式期间一律走 textContent 纯文本，收尾后再一次性渲染。
   */
  setLast(text, isFinal) {
    if (!this.messages.length) return this.push("assistant", text);
    const idx = this.messages.length - 1;
    this.messages[idx].text = text || "";
    const b = this.$bubbles && this.$bubbles[this.$bubbles.length - 1];
    if (!b) { this.render(); return; }
    const stick = this.atBottom();
    if (isFinal) {
      while (b.firstChild) b.removeChild(b.firstChild);
      b.classList.remove("md");
      fillBubble(b, "assistant", text);
      // 空回答时"复制/重答"是隐藏的，收尾后要补上
      const wrap = b.parentNode;
      if (wrap) {
        const old = wrap.querySelector(".acts");
        if (old) old.replaceWith(this.msgActions(idx, this.messages[idx]));
      }
    } else {
      b.textContent = text || "";
    }
    if (stick) this.scrollToEnd();
  },

  render() {
    if (!this.$list) return;
    const stick = this.atBottom();     // v1.3.1：重建前先记住"用户是不是就在底部"
    while (this.$list.firstChild) this.$list.removeChild(this.$list.firstChild);
    this.$bubbles = [];

    if (!this.messages.length) {
      this.renderEmpty();
      if (stick) this.scrollToEnd();
      return;
    }

    this.messages.forEach((m, idx) => {
      const who = { user: "我", assistant: "DSH", note: "·", error: "错误" }[m.role] || m.role;
      const bubble = el("div", { class: "bubble" });
      fillBubble(bubble, m.role, m.text);      // v1.4.0：assistant 走 Markdown
      this.$bubbles.push(bubble);              // 与 messages 同序
      this.$list.appendChild(el("div", { class: "msg " + m.role },
        el("div", { class: "who" },
          el("span", { text: who }),
          el("span", { class: "spacer" }),
          this.msgActions(idx, m)),
        bubble));
    });
    if (stick) this.scrollToEnd();
  },

  // 空状态：从"纯文案"改成"可点的预设动作卡片"
  // v1.4.0 —— 这 6 条预设以前只存在于主窗口右键菜单，对话窗口里根本看不到。
  renderEmpty() {
    const box = el("div", { class: "empty" },
      el("div", { text: "在这里直接问 DSH。" }),
      el("div", { class: "dim",
        text: "勾选「附带选中的文献」时，会把 Zotero 里选中条目的元数据与全文一起发过去。" }),
      el("div", { class: "dim",
        text: "同一窗口内的追问会续接同一会话（顶栏会显示会话状态）。" }),
    );
    const cards = el("div", { class: "cards" });
    let ps = [];
    try { ps = (this.bridge && this.bridge.presets) ? this.bridge.presets() : []; } catch (e) {}
    for (const [label, q] of ps) {
      cards.appendChild(el("button", {
        class: "card", title: q, onclick: () => this.send(q),
      }, el("span", { text: label })));
    }
    box.appendChild(cards);
    this.$list.appendChild(box);
  },

  // 每条消息的操作按钮（悬停显现）
  msgActions(idx, m) {
    const acts = el("span", { class: "acts" });
    if (m.role === "assistant" && (m.text || "").trim()) {
      acts.appendChild(el("button", { class: "actbtn", onclick: () => this.copyMsg(idx), text: "复制" }));
      acts.appendChild(el("button", { class: "actbtn", onclick: () => this.regenerate(idx), text: "重答" }));
    }
    if (m.role === "user") {
      acts.appendChild(el("button", { class: "actbtn", onclick: () => this.editUser(idx), text: "改后再发" }));
    }
    if (m.role === "user" || m.role === "assistant") {
      acts.appendChild(el("button", { class: "actbtn", onclick: () => this.deleteMsg(idx), text: "删除" }));
    }
    return acts;
  },

  // ---------- 状态 ----------
  setStatus(s) { if (this.$status) this.$status.textContent = s; },

  updateSession() {
    if (!this.$sess) return;
    if (this.sessionId) {
      this.$sess.textContent = "会话 " + this.sessionId.replace(/^session-/, "").slice(0, 8) + "…";
      this.$sess.classList.add("on");
    } else {
      this.$sess.textContent = "新会话";
      this.$sess.classList.remove("on");
    }
  },

  setContext(n, chars) {
    this.lastContext = { n, chars };
    if (this.$ctx) this.$ctx.textContent = n ? `${n} 条 / ${chars} 字` : "未附材料";
  },

  setBusy(b) {
    this.busy = b;
    if (this.$send) this.$send.disabled = b;
    if (this.$stop) this.$stop.disabled = !b;
    if (b) this.setStatus("正在思考…");
  },

  setAnswer(t, isFinal) { this.setLast(t, isFinal); },
  appendUser(q) { this.push("user", q); },
  appendNote(s) { this.push("note", s); },

  // ---------- 材料面板 ----------

  /**
   * 重建面板。两个页签：材料 / 引文（v1.7.0 加了引文页）。
   * 面板在消息区与工具条之间，默认折叠 —— 它不该挤占对话。
   */
  renderPanel() {
    const P = this.$materials;
    if (!P) return;
    const mats = this.matReport || [];
    const cits = this.citReport || [];
    if (!mats.length && !cits.length) { P.hidden = true; return; }
    P.hidden = false;
    while (P.firstChild) P.removeChild(P.firstChild);

    const withText = mats.filter((r) => (r.chars || 0) > 0).length;
    const total = mats.reduce((s, r) => s + (r.chars || 0), 0);
    const matched = cits.filter((c) => c.match).length;

    const tabMat = el("span", {
      class: "ptab" + (this.panelTab === "materials" ? " on" : ""),
      text: `材料 ${mats.length}`,
      onclick: () => { this.panelTab = "materials"; this.panelOpen = true; this.renderPanel(); },
    });
    const tabCit = el("span", {
      class: "ptab" + (this.panelTab === "citations" ? " on" : ""),
      text: `引文 ${cits.length}` + (cits.length ? `（可核对 ${matched}）` : ""),
      onclick: () => { this.panelTab = "citations"; this.panelOpen = true; this.renderPanel(); },
    });

    P.appendChild(el("div", { class: "mat-head" },
      tabMat, tabCit,
      el("span", { class: "spacer" }),
      el("span", {
        class: "mat-sum",
        text: this.panelTab === "materials"
          ? `带全文 ${withText} 条 · 共 ${total} 字`
          : (cits.length ? `已核对 ${matched} / ${cits.length}` : ""),
      }),
      el("span", {
        class: "caret", text: this.panelOpen ? "▾" : "▸",
        onclick: () => { this.panelOpen = !this.panelOpen; this.renderPanel(); },
      })));

    if (!this.panelOpen) return;
    const body = el("div", { class: "mat-body" });
    if (this.panelTab === "materials") this.renderMaterialRows(body);
    else this.renderCitationRows(body);
    P.appendChild(body);
  },

  renderMaterialRows(body) {
    const STATE = {
      full: "全文",
      partial: (r) => `截取前 ${r.chars} 字 / 共 ${r.total} 字`,
      omitted: () => "因长度上限略去",
      "no-pdf": () => "无 PDF 附件（仅元数据）",
      "no-index": () => "无全文索引——可能是未 OCR 的扫描件",
      error: (r) => "取全文失败：" + (r.err || ""),
      "meta-only": () => "仅元数据（本次未取全文）",
    };
    for (const r of this.matReport || []) {
      const f = STATE[r.state];
      const label = typeof f === "function" ? f(r) : (f || r.state || "");
      const warn = (r.state === "omitted" || r.state === "error" || r.state === "no-index");
      body.appendChild(el("div", {
        class: "mat-row" + (r.itemID ? " clickable" : ""),
        title: r.itemID ? "点击：在 Zotero 主窗口中定位这一条" : "",
        // v1.9.1：改成 async + await —— revealInZotero 是异步的，
        // 不 await 的话这里的 try/catch 抓不到它的 rejection，
        // 定位失败时界面照样显示"已在 Zotero 中定位"（界面说谎）。
        onclick: r.itemID ? async () => {
          try { await this.bridge.revealInZotero([r.itemID]); this.setStatus("已在 Zotero 中定位"); }
          catch (e) { this.setStatus("定位失败：" + (e && e.message ? e.message : e)); }
        } : null,
      },
        el("span", { class: "mat-title", text: r.title || "(无题)", title: r.title || "" }),
        el("span", { class: "mat-meta" + (warn ? " mat-warn" : ""), text: label })));
    }
  },

  /**
   * 引文行：左边是回答里出现的引文，右边是它在哪篇材料里对得上。
   * 对不上的**照实说"未在材料中找到"** —— 这正是不该替模型圆场的地方：
   * 可能是模型自己的话，也可能是 kb 检索回来的、不在本次材料里的段落。
   */
  renderCitationRows(body) {
    let cits = this.citReport || [];
    if (!cits.length) {
      body.appendChild(el("div", { class: "mat-row" },
        el("span", { class: "mat-title", text: "这段回答里没检出引文（引号内或引用块中的整句）" })));
      return;
    }
    const unmatched = cits.filter((c) => !c.match).length;
    // v1.9.2：加一个「只看未命中」开关 —— 那才是抓编造的用法。
    // 实测一条回答能抽出 50–79 条（预设里就有"列出可引用的关键句"），全列出来会淹掉重点。
    body.appendChild(el("div", { class: "mat-row citfilter" },
      el("span", {
        class: "ptab" + (this.citOnlyUnmatched ? " on" : ""),
        text: this.citOnlyUnmatched ? "只看未命中 ✓" : "只看未命中",
        onclick: () => { this.citOnlyUnmatched = !this.citOnlyUnmatched; this.renderPanel(); },
      }),
      el("span", { class: "mat-meta", text: `命中 ${cits.length - unmatched} · 未命中 ${unmatched}` })));

    if (this.citOnlyUnmatched) cits = cits.filter((c) => !c.match);

    const CAP = 40;
    const shown = cits.slice(0, CAP);
    for (const c of shown) {
      const q = c.quote.length > 64 ? c.quote.slice(0, 64) + "…" : c.quote;
      const hit = c.match;
      const meta = hit
        ? (hit.kind === "exact" ? `原文一致 · ${hit.title}` : `近似 ${Math.round(hit.ratio * 100)}% · ${hit.title}`)
        : "未在本次材料中找到";
      const row = el("div", {
        class: "mat-row cit" + (hit && hit.itemID ? " clickable" : ""),
        title: (hit ? "点击：在 Zotero 中定位来源" : "") + "\n\n" + c.quote,
        // v1.9.1：同为 async + await（见材料行的同一条注释）
        onclick: (hit && hit.itemID) ? async () => {
          try { await this.bridge.revealInZotero([hit.itemID]); this.setStatus("已在 Zotero 中定位来源"); }
          catch (e) { this.setStatus("定位失败：" + (e && e.message ? e.message : e)); }
        } : null,
      },
        el("span", { class: "cit-q", text: q, title: c.quote }),
        el("span", { class: "mat-meta" + (hit ? "" : " mat-warn"), text: meta }));
      body.appendChild(row);
    }
    if (cits.length > CAP) {
      body.appendChild(el("div", { class: "mat-row" },
        el("span", { class: "mat-meta", text: `（另有 ${cits.length - CAP} 条未列出）` })));
    }
  },

  setMaterials(report) {
    this.matReport = Array.isArray(report) ? report : [];
    this.renderPanel();
  },

  setCitations(list) {
    this.citReport = Array.isArray(list) ? list : [];
    this.renderPanel();
  },

  // ---------- 引文抽取与核对（v1.7.0）----------
  // 实现在 content/cite.js 里，做成纯函数模块以便在 node 里单测
  // （"这句到底是不是原文"是这套 UI 里最该守住的一环，不能靠肉眼）。

  _cite() { return (typeof CITE !== "undefined" && CITE) ? CITE : null; },

  norm(s) { const C = this._cite(); return C ? C.norm(s) : String(s == null ? "" : s); },
  extractQuotes(t) { const C = this._cite(); return C ? C.extractQuotes(t) : []; },

  /** 回答收尾后刷新引文页 */
  refreshCitations() {
    const last = this.lastAssistant();
    const C = this._cite();
    if (!last || !C) { this.setCitations([]); return; }
    try {
      const qs = C.extractQuotes(last);
      const mats = (this.matReport || []).filter((r) => typeof r.text === "string" && r.text);
      const cits = C.matchQuotes(qs, mats);
      this.setCitations(cits);
      const hit = cits.filter((c) => c.match).length;
      chatLog(`引文核对：从回答里抽出 ${cits.length} 条，对得上材料的 ${hit} 条（可比对材料 ${mats.length} 篇）`);
    } catch (e) { chatLog("引文核对失败：" + e); this.setCitations([]); }
  },

  // ---------- 工作区（v1.6.0）----------

  /**
   * 从 DSH 的工作区登记表拉列表填进下拉框。
   * 登记表 ≈/.dsh/storages/workspace.json，由 bootstrap.js 读（本窗口读不了文件系统）。
   */
  loadWorkspaces() {
    if (!this.$ws) return;
    let list = [];
    try { if (this.bridge && this.bridge.listWorkspaces) list = this.bridge.listWorkspaces() || []; }
    catch (e) { chatLog("读工作区失败：" + e); }
    const cur = (this.bridge && this.bridge.getWorkspacePref) ? this.bridge.getWorkspacePref() : "";

    while (this.$ws.firstChild) this.$ws.removeChild(this.$ws.firstChild);
    const none = el("option", { value: "", text: "（Zotero 的当前目录）" });
    this.$ws.appendChild(none);

    let matched = false;
    for (const w of list) {
      const o = el("option", { value: w.path, text: w.title });
      if (w.path === cur) { o.selected = true; matched = true; }
      this.$ws.appendChild(o);
    }
    // 当前值是手填的、不在登记表里 → 补一项，免得下拉框显示成别的工作区
    if (cur && !matched) {
      const o = el("option", { value: cur, text: cur + "（自定义）" });
      o.selected = true;
      this.$ws.appendChild(o);
    }
    if (!cur) none.selected = true;
    chatLog("工作区下拉：登记表 " + list.length + " 项，当前=" + (cur || "(未指定)"));
  },

  onWorkspaceChange() {
    const v = this.$ws ? this.$ws.value : "";
    if (this.bridge && this.bridge.setWorkspace) this.bridge.setWorkspace(v);
    this.setStatus(v ? ("工作区： " + v + "　（下一条生效）")
                     : "工作区已清空（将跑在 Zotero 的当前目录）");
  },

  // ---------- 写回 Zotero（v1.6.0）----------

  /** 本次材料对应的 Zotero 条目 id（材料面板里的行就是这些） */
  materialIDs() {
    return (this.matReport || [])
      .map((r) => r.itemID)
      .filter((x) => typeof x === "number" && x > 0);
  },

  /** 「在 Zotero 中显示」—— 把所列文献在 Zotero 主窗口里选中（即以列表形式呈现） */
  async revealMaterials() {
    const ids = this.materialIDs();
    if (!ids.length) { this.setStatus("本次没有材料条目可定位"); return; }
    try {
      const n = await this.bridge.revealInZotero(ids);
      this.setStatus(`已在 Zotero 主窗口选中 ${n} 条`);
    } catch (e) { this.setStatus("定位失败：" + (e && e.message ? e.message : e)); }
  },

  /** 「建集合」—— 把这些条目归到一个集合里，之后在 Zotero 里可反复调出 */
  async groupMaterials() {
    const ids = this.materialIDs();
    if (!ids.length) { this.setStatus("本次没有材料条目可归集"); return; }
    try {
      const name = (this.bridge.getPref && this.bridge.getPref("noteCollectionName"))
        || "DSH Bridge · 会话材料";
      const r = await this.bridge.groupAsCollection(ids, name);
      this.setStatus(`已加入集合「${r.name}」（${r.count} 条）`);
    } catch (e) { this.setStatus("建集合失败：" + (e && e.message ? e.message : e)); }
  },

  /**
   * 把整段对话组成 Zotero 笔记的 HTML。
   * 所有来自模型/用户的文本都过 MD.toHTML() 或 MD.esc() —— 不拼任何未转义内容。
   */
  /**
   * v1.7.0：把会话登记进 DSH 工作区。
   * 机制已核实：DSH 界面**不扫会话桶**，只列 workspace.json 里各工作区 `sessionIds`
   * 中的会话 —— 插件在界面外建的会话因此在界面里看不见（桶里 93 个，登记表只认 29 个）。
   * 登记后即可在 DSH 界面直接看到，不必再导入。
   *
   * v1.9.0：`workspace` 必须由调用方从 runDSH 的结果里传进来 —— 会话落在哪个桶由
   * **spawn 时的 workdir** 决定；在这里临时读首选项，用户在运行期间切了工作区就会
   * 「登记到 A、文件在 B」。
   */
  async registerSession(sid, workspace, force) {
    if (!sid || !this.bridge || !this.bridge.registerSessionInWorkspace) return;
    try {
      const r = await this.bridge.registerSessionInWorkspace(sid, workspace, force ? { force: true } : undefined);
      if (r && r.ok) {
        // v1.10.0：把"为什么界面里看不见"说清楚。
        // 已确证：DSH 的 host 在**启动时**把 workspace.json 读进内存，之后不监视文件
        //   （dsh-workspace 的 sessionKnown() 第一句就是查内存里"活着的会话"；
        //     registry 里没有任何 watch）。
        // 实据：3080 端口那个 GUI 进程 10-16 18:12 启动，而登记写入在 10-17 01:15 ——
        //   晚了近 7 小时，它一直没重启，所以界面里看不到。
        if (r.already) {
          this.setStatus("会话已在 DSH 工作区登记表中");
        } else if (!this.regHintShown) {
          this.regHintShown = true;
          this.setStatus(`会话已登记进工作区「${r.title}」。⚠️ DSH 把工作区表读在内存里 —— `
            + `若 DSH 界面正开着，需**完全退出并重启 DSH** 才会看到（另开一个会因端口 3080 被占而失败）。`);
          this.push("note", "（会话已写入 DSH 的工作区登记表。DSH 只在启动时读它一次 —— "
            + "所以要让 DSH 界面看到这条会话，需要完全退出 DSH 再重新启动；"
            + "直接另开一个会因端口占用而启动失败，老那个还在跑。）");
        } else {
          this.setStatus(`会话已登记进工作区「${r.title}」（DSH 需重启才会显示）`);
        }
      } else if (r && r.archived) {
        // v1.9.2：如实说它被归档了，并告诉用户怎么取回（默认不擅自改用户的归档决定）
        this.setStatus(r.why);
      } else if (r && r.why) {
        chatLog("会话登记未完成：" + r.why + "（不影响对话，只是界面里看不到）");
        if (r.why && r.why.indexOf("还没在 DSH 里登记") >= 0) this.setStatus(r.why);
      }
      return r;
    } catch (e) { chatLog("会话登记失败：" + e); return null; }
  },

  /** 历史栏的「重新登记」：连归档状态一起取回（显式动作，不自动做） */
  async reregisterCurrent() {
    if (!this.sessionId) { this.setStatus("当前没有会话号（先问一句）"); return; }
    this.setStatus("正在重新登记…");
    await this.registerSession(this.sessionId, this.runWorkspace || undefined, true);
  },

  /** v1.9.0：记住本次运行实际用的工作区，供历史条目如实记录 */
  setRunWorkspace(w) { this.runWorkspace = String(w == null ? "" : w); },

  // ---------- 会话历史（v1.8.0）----------

  loadHistoryFromBridge() {
    try {
      this.history = (this.bridge && this.bridge.loadHistory)
        ? this.bridge.loadHistory() : { version: 1, sessions: [] };
    } catch (e) { chatLog("读历史失败：" + e); this.history = { version: 1, sessions: [] }; }
    this.renderHistory();
  },

  toggleSide() {
    this.sideOpen = !this.sideOpen;
    if (this.$side) this.$side.classList.toggle("open", this.sideOpen);
    if (this.sideOpen) this.renderHistory();
    else this.setStatus("历史栏已收起");
  },

  renderHistory() {
    const S = this.$side;
    if (!S) return;
    while (S.firstChild) S.removeChild(S.firstChild);
    const list = (this.history && Array.isArray(this.history.sessions)) ? this.history.sessions : [];
    S.appendChild(el("div", { class: "side-head" },
      el("span", { text: "会话历史 " + list.length }),
      el("span", { class: "spacer" }),
      // v1.9.2：显式的「重新登记」——用于会话被归档后取回（默认不自动覆盖归档）
      el("span", {
        class: "side-act", text: "重新登记",
        title: "把当前会话重新登记进所选工作区；若它已被归档，一并取回",
        onclick: () => this.reregisterCurrent(),
      })));
    if (!list.length) {
      S.appendChild(el("div", {
        class: "side-empty",
        text: "（还没有记录）\n对话结束后会出现在这里；点一条就能接着它聊。",
      }));
      return;
    }
    for (const s of list) {
      const cur = !!(s.sid && s.sid === this.sessionId);
      const when = new Date(s.updatedAt || s.createdAt || Date.now());
      S.appendChild(el("div", {
        class: "side-item" + (cur ? " on" : ""),
        title: (s.title || "") + "\n" + when.toLocaleString() + "\n" + (s.workspace || ""),
        onclick: () => this.loadHistoryEntry(s.sid),
      },
        el("div", { class: "side-title", text: s.title || "(无题)" }),
        el("div", {
          class: "side-meta",
          text: (s.messages ? s.messages.length : 0) + " 条 · " + when.toLocaleDateString(),
        })));
    }
  },

  /**
   * 载入一条历史：把对话铺回消息区并接上会话号 —— 之后的追问会接着它走。
   * 说明：DSH 那边的会话文件是 zstd 压缩的，插件解不开，所以这里用的是我们自己存的那份文本；
   *      两者对应**同一个 session-id**，续接仍落在 DSH 的真实会话上。
   */
  loadHistoryEntry(sid) {
    if (this.busy) { this.setStatus("有请求正在运行，先等它结束"); return; }
    const e = ((this.history && this.history.sessions) || []).find((s) => s.sid === sid);
    if (!e) { this.setStatus("这条历史已不在记录里"); return; }
    this.messages = (e.messages || []).map((m) => ({ role: m.role, text: m.text }));
    this.sessionId = e.sid || null;
    this.updateSession();
    this.setCitations([]);
    this.render();
    this.renderHistory();
    this.setStatus("已载入历史会话 —— 继续追问会接着它走");
  },

  /** 每轮结束后存一次（没有会话号就不存：存了也接不回去） */
  saveHistory() {
    if (!this.sessionId) return;
    if (!this.bridge || !this.bridge.saveHistory) return;
    try {
      const h = this.history || (this.history = { version: 1, sessions: [] });
      if (!Array.isArray(h.sessions)) h.sessions = [];
      const now = Date.now();
      let e = h.sessions.find((s) => s.sid === this.sessionId);
      if (!e) { e = { sid: this.sessionId, createdAt: now, messages: [] }; h.sessions.unshift(e); }
      e.updatedAt = now;
      e.title = this.makeNoteTitle();
      // v1.9.0：记**本次实际用的**工作区（没有就退回当前首选项）
      e.workspace = this.runWorkspace || (this.bridge.getWorkspace ? this.bridge.getWorkspace() : "");
      e.messages = this.messages.map((m) => ({ role: m.role, text: m.text }));
      this.bridge.saveHistory(h);
      this.renderHistory();
    } catch (err) { chatLog("存历史失败：" + err); }
  },

  /**
   * v1.7.0：Zotero 笔记**没有独立的标题字段** —— 条目列表里显示的就是正文第一行。
   * 所以以前每条笔记都叫「DSH 对话记录」，一眼分不出谁是谁。这里按内容现算一个。
   */
  makeNoteTitle() {
    const firstUser = (this.messages.find((m) => m.role === "user") || {}).text || "";
    let q = String(firstUser)
      .replace(/　（附 \d+ 条文献）$/, "")
      .replace(/　（来自阅读器）$/, "")
      .replace(/\s+/g, " ").trim();
    if (q.length > 28) q = q.slice(0, 28) + "…";

    const mats = this.matReport || [];
    const withText = mats.filter((m) => (m.chars || 0) > 0);
    let prefix = "";
    if (withText.length === 1) {
      const t = String(withText[0].title || "");
      prefix = (t.length > 16 ? t.slice(0, 16) + "…" : t) + " — ";
    } else if (mats.length > 1) {
      prefix = `${mats.length} 篇 · `;
    }
    return (prefix + (q || "DSH 对话")).slice(0, 80);
  },

  buildNoteHTML(titleOverride) {
    const esc = (typeof MD !== "undefined" && MD.esc) ? MD.esc : ((s) => String(s == null ? "" : s));
    const toHTML = (typeof MD !== "undefined" && MD.toHTML) ? MD.toHTML : esc;

    // 首行 = 笔记的"标题"（Zotero 用正文首行当条目标题）
    let h = "<h1>" + esc(titleOverride || this.makeNoteTitle()) + "</h1>";
    const ws = (this.bridge && this.bridge.getWorkspace) ? this.bridge.getWorkspace() : "";
    h += "<p><i>" + esc(new Date().toLocaleString()) + "　·　工作区：" + esc(ws) + "</i></p>";

    const mats = this.matReport || [];
    if (mats.length) {
      h += "<h2>本次材料</h2><ol>";
      for (const m of mats) h += "<li>" + esc(m.title || "(无题)") + "</li>";
      h += "</ol>";
    }

    const WHO = { user: "我", assistant: "DSH", note: "备注", error: "错误" };
    for (const m of this.messages) {
      const who = m.role === "assistant" ? "DSH" : esc(WHO[m.role] || m.role);
      h += "<h2>" + who + "</h2>" + toHTML(m.text || "");
    }
    return h;
  },

  /** 「存为笔记」—— 挂到本次材料第 1 条之下；没有材料就建独立笔记 */
  async saveNote() {
    if (!this.messages.length) { this.setStatus("还没有对话内容"); return; }
    if (!this.bridge || !this.bridge.createNote) { this.setStatus("bridge 不支持写笔记"); return; }
    try {
      const html = this.buildNoteHTML();
      const ids = this.materialIDs();
      const parent = ids.length ? ids[0] : null;
      const r = await this.bridge.createNote(html, parent);
      this.lastNoteID = r.id;          // v1.7.0：记下来，供「AI 起标题」用
      this.setStatus(r.parentID
        ? `已存为笔记 #${r.id}（挂在材料第 1 条之下）`
        : `已存为独立笔记 #${r.id}`);
      this.push("note", r.parentID
        ? `（对话已写入 Zotero 笔记 #${r.id}，位于材料第 1 条之下；标题按内容生成，可在 Zotero 里直接改）`
        : `（对话已写入 Zotero 独立笔记 #${r.id}；标题按内容生成）`);
    } catch (e) {
      this.push("error", "存笔记失败：" + (e && e.message ? e.message : e));
    }
  },

  /**
   * v1.7.0：「AI 起标题」—— 让 DSH 现起一个短标题并回填笔记首行。
   * 注意这会**再跑一次 DSH**（几十秒），所以做成显式动作，不自动挂在保存流程上：
   * 保存时先用本地规则给一个好用的标题，不满意再点这个。
   */
  async aiTitle() {
    if (!this.lastNoteID) { this.setStatus("先点「存为笔记」，再对它起标题"); return; }
    if (this.busy) { this.setStatus("有请求正在运行，稍后再试"); return; }

    const first = String((this.messages.find((m) => m.role === "user") || {}).text || "")
      .replace(/　（附 \d+ 条文献）$/, "");
    const last = String(this.lastAssistant() || "").slice(0, 1500);
    if (!first && !last) { this.setStatus("没有内容可据以起标题"); return; }

    const prompt = "请为下面这段对话起一个中文标题。要求：不超过 16 个字，概括主题，"
      + "不要引号、不要书名号、不要标点、不要任何解释，只输出标题本身。\n\n"
      + "【提问】" + first + "\n\n【回答节选】" + last;

    this.setStatus("正在让 DSH 起标题…");
    try {
      const { text } = await this.bridge.runDSH(prompt, {
        onQueued: (n) => this.setStatus(`排队中（前面还有 ${n} 个）…`),
      });
      let t = String(text || "").trim().split("\n")[0] || "";
      t = t.replace(/^[#\s「『“"'《]+/, "").replace(/[」』”"'》\s。，、：:]+$/, "");
      if (t.length > 40) t = t.slice(0, 40);
      if (!t) { this.setStatus("没拿到标题（回答为空）"); return; }

      await this.bridge.updateNote(this.lastNoteID, this.buildNoteHTML(t));
      this.setStatus("标题已更新：" + t);
      this.push("note", `（笔记 #${this.lastNoteID} 的首行已改为「${t}」—— Zotero 用它当条目标题）`);
    } catch (e) {
      this.setStatus("起标题失败：" + (e && e.message ? e.message : e));
    }
  },

  // ---------- 单条消息的操作 ----------

  copyText(t) {
    const C = (typeof Components !== "undefined") ? Components : null;
    try {
      C.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(C.interfaces.nsIClipboardHelper).copyString(t);
      return true;
    } catch (e) { return false; }
  },

  copyMsg(idx) {
    const m = this.messages[idx];
    if (!m || !m.text) { this.setStatus("这条没有内容"); return; }
    this.setStatus(this.copyText(m.text) ? "已复制" : "复制失败");
  },

  deleteMsg(idx) {
    if (idx < 0 || idx >= this.messages.length) return;
    this.messages.splice(idx, 1);
    this.render();
    this.setStatus("已删除");
  },

  /** 把某条用户消息放回输入框，并砍掉它之后的对话（编辑重发的语义） */
  editUser(idx) {
    const m = this.messages[idx];
    if (!m || m.role !== "user") return;
    this.$input.value = String(m.text || "").replace(/　（附 \d+ 条文献）$/, "");
    this.messages.splice(idx, this.messages.length - idx);
    this.render();
    this.$input.focus();
    this.setStatus("已放回输入框；改完再发（其后的对话已一并移除）");
  },

  /** 重答：找到这条回答对应的上一条提问，砍掉它之后的对话，重新发一次 */
  async regenerate(idx) {
    if (this.busy) { this.setStatus("有请求正在运行，稍后再试"); return; }
    let q = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (this.messages[i].role === "user") { q = this.messages[i].text; break; }
    }
    if (!q) { this.setStatus("找不到这条回答对应的提问"); return; }
    q = String(q).replace(/　（附 \d+ 条文献）$/, "");
    this.messages.splice(idx - 1, this.messages.length - (idx - 1));  // 连同那条提问一起砍掉
    this.render();
    await this.send(q);
  },

  // ---------- 动作 ----------
  newSession() {
    this.sessionId = null;
    this.usage = null;
    this.updateSession();
    this.setCitations([]);
    this.renderHistory();     // v1.8.0：取消历史条目的高亮
    this.setStatus("已开新会话");
    this.push("note", "（下一条消息将开启新的 DSH 会话）");
  },

  async refreshContext() {
    if (!this.bridge) return;
    try {
      const items = this.bridge.selectedItems();
      if (!items.length) {
        this.setContext(0, 0); this.setMaterials([]);
        this.setStatus("主窗口没有选中条目"); return;
      }
      this.setStatus("正在统计选中文献…");
      // v1.4.0：连材料面板一起刷新，点一下就能看清模型会拿到什么
      const detailed = await this.bridge.collectContextDetailed(items, {
        fulltext: this.bridge.getPref("includeFulltext"),
      });
      this.setContext(items.length, detailed.text.length);
      this.setMaterials(detailed.report);
      this.setStatus("已刷新");
    } catch (e) { this.setStatus("刷新失败"); }
  },

  clearAll() {
    this.messages = [];
    this.sessionId = null;
    this.usage = null;
    this.setCitations([]);      // v1.7.0：引文页一并清掉
    this.updateSession();
    this.render();
    this.setStatus("已清空");
  },

  abort() {
    // v1.3.1：v1.3.0 无论有没有请求在跑都提示「子进程已被 kill」。
    // v1.5.0：串行化以后 abortCurrent() 返回 { killed, dropped } ——
    //   killed = 是否真杀了正在跑的进程；dropped = 一并清掉了几条排队中的请求。
    let r = { killed: false, dropped: 0 };
    try {
      if (this.bridge && this.bridge.abortCurrent) r = this.bridge.abortCurrent() || r;
    } catch (e) {}
    this.setBusy(false);
    this.setStatus("已中止");
    let msg = r.killed ? "（已中止当前请求；子进程已被 kill）"
                       : "（当前没有正在运行的请求）";
    if (r.dropped) msg += `；并清掉了 ${r.dropped} 条排队中的请求`;
    this.push("note", msg);
  },

  lastAssistant() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") return this.messages[i].text;
    }
    return "";
  },

  async copyLast() {
    const t = this.lastAssistant();
    if (!t) { this.setStatus("还没有回答"); return; }
    const C = (typeof Components !== "undefined") ? Components : null;

    // v1.3.1：首选 nsIClipboardHelper。v1.3.0 用 document.execCommand("copy")，
    // 该 API 已废弃，在 XUL 外壳窗口里依赖隐藏 textarea 的选中状态，行为不稳。
    try {
      const helper = C.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(C.interfaces.nsIClipboardHelper);
      helper.copyString(t);
      this.setStatus("已复制到剪贴板");
      return;
    } catch (e) { /* 落到下面的旧办法 */ }

    try {
      const doc = window.document;
      const ta = doc.createElementNS(XHTML_NS, "textarea");
      ta.value = t;
      doc.documentElement.appendChild(ta);
      ta.select();
      doc.execCommand("copy");
      ta.remove();
      this.setStatus("已复制到剪贴板");
    } catch (e) {
      this.push("note", "（自动复制失败，请手动选中回答区复制）");
    }
  },

  async saveToFile() {
    const t = this.lastAssistant();
    if (!t) { this.setStatus("还没有回答"); return; }
    const C = (typeof Components !== "undefined") ? Components : null;
    const CC = (typeof Cc !== "undefined") ? Cc : (C ? C.classes : null);
    const CI = (typeof Ci !== "undefined") ? Ci : (C ? C.interfaces : null);
    if (!CC || !CI) { this.setStatus("保存失败：拿不到 Components"); return; }
    try {
      const fp = CC["@mozilla.org/filepicker;1"].createInstance(CI.nsIFilePicker);
      fp.init(window, "保存 DSH 的回答", CI.nsIFilePicker.modeSave);
      fp.defaultString = `DSH回答-${new Date().toISOString().slice(0, 10)}.md`;
      fp.appendFilter("Markdown", "*.md");
      fp.appendFilters(CI.nsIFilePicker.filterAll);
      const rv = await new Promise((res) => fp.open(res));
      if (rv === CI.nsIFilePicker.returnCancel || !fp.file) return;
      const fos = CC["@mozilla.org/network/file-output-stream;1"]
        .createInstance(CI.nsIFileOutputStream);
      fos.init(fp.file, 0x02 | 0x08 | 0x20, parseInt("0666", 8), 0);
      const cos = CC["@mozilla.org/intl/converter-output-stream;1"]
        .createInstance(CI.nsIConverterOutputStream);
      cos.init(fos, "UTF-8");
      cos.writeString(t);
      cos.close();
      this.setStatus("已保存：" + fp.file.path);
    } catch (e) {
      this.setStatus("保存失败");
      this.push("error", "保存失败：" + (e && e.message ? e.message : e));
    }
  },

  // ---------- 发送 ----------
  /**
   * @param {string} [preset] 传入则直接以它作为问题（快捷动作卡片走这条），
   *                          不读输入框、也不清空输入框。
   */
  async send(preset) {
    chatLog("send() 被调用");
    if (this.busy) return;
    const fromCard = (typeof preset === "string" && preset);
    const q = (fromCard ? preset : (this.$input.value || "")).trim();
    if (!q) { this.setStatus("请先输入问题"); return; }
    if (!this.bridge) { this.push("error", "DSHBridge 未就绪。"); return; }
    chatLog("问题长度 " + q.length + "，带上下文=" + this.$usectx.checked);

    const withCtx = this.$usectx.checked;
    let ctx = "";
    let n = 0;
    if (withCtx) {
      this.setStatus("正在收集选中文献…");
      try {
        const items = this.bridge.selectedItems();
        n = items.length;
        if (n) {
          // v1.4.0：改用 detailed —— 同时拿到 { text, report }，
          // report 交给材料面板逐条展示（以前窗口里只有一行"N 条 / M 字"）。
          const detailed = await this.bridge.collectContextDetailed(items, {
            fulltext: this.bridge.getPref("includeFulltext"),
          });
          ctx = detailed.text;
          this.setMaterials(detailed.report);
        } else {
          this.setMaterials([]);
        }
      } catch (e) {
        this.push("note", "（收集上下文失败：" + (e && e.message ? e.message : e) + "）");
        this.setMaterials([]);
      }
    } else {
      this.setMaterials([]);
    }
    this.setContext(n, ctx.length);

    const prompt = this.bridge.buildPrompt
      ? this.bridge.buildPrompt(ctx, q)
      : (ctx ? "材料：\n" + ctx + "\n\n" : "") + "我的问题：" + q;

    this.push("user", q + (n ? `　（附 ${n} 条文献）` : ""));
    this.push("assistant", "");
    this.setBusy(true);
    if (!fromCard) this.$input.value = "";   // 卡片触发时不动输入框

    try {
      const { text, code, sessionId, usage, workspace, stderrTail } = await this.bridge.runDSH(prompt, {
        sessionId: this.sessionId,
        onChunk: (t) => this.setLast(t),     // 流式期间纯文本
        // v1.5.0：串行闸门 —— 有别的入口（阅读器/右键菜单）在跑时，这条会排队
        onQueued: (n) => this.setStatus(`排队中（前面还有 ${n} 个）…`),
        onEvent: (ev) => {
          if (ev.sessionId && ev.sessionId !== this.sessionId) {
            this.sessionId = ev.sessionId;
            this.updateSession();
          }
          if (ev.type === "status" && ev.phase === "step_start") {
            this.setStatus(`进行中：第 ${ev.turn || "?"} 轮 · 第 ${ev.step || "?"} 步`);
          } else if (ev.type === "status" && ev.phase === "step_end" && ev.usage) {
            // v1.9.2：累加（与 bootstrap 同一口径）—— 旧写法只留最后一步
            const u0 = this.usage || { inputTokens: 0, outputTokens: 0, steps: 0 };
            this.usage = {
              inputTokens: (u0.inputTokens || 0) + (ev.usage.inputTokens || 0),
              outputTokens: (u0.outputTokens || 0) + (ev.usage.outputTokens || 0),
              steps: (u0.steps || 0) + 1,
            };
          }
        },
      });

      if (sessionId) {
        this.sessionId = sessionId;
        this.updateSession();
        // v1.9.0：带上本次实际用的工作区 —— 否则会「登记到 A、文件在 B」
        this.registerSession(sessionId, workspace);
      }
      this.setRunWorkspace(workspace);
      if (!text) {
        this.setLast("", true);
        // v1.11.0：把**真正的错因**摆出来。
        // 旧版只会说"没有返回内容"，而 stderr 里明明写着原因
        // （2026-10-18 那次就是 MISSING_CREDENTIAL：profile 的凭据服务被禁用）。
        if (stderrTail) {
          this.push("error", `DSH 没有返回内容（退出码 ${code}）。stderr 末尾：\n${stderrTail}`);
        } else {
          this.appendNote(`没有返回内容（退出码 ${code}）。可用命令行复现：\n`
            // v1.3.1：这里原来写死 --profile headless（那个 profile 一个插件都没装）。
            + `echo 测试 | node "${this.bridge.getPref("dshBin")}" `
            + `--profile "${this.bridge.getPref("profile")}" --json -`);
        }
      } else {
        this.setLast(text, true);      // v1.4.0：收尾时才渲染 Markdown
        this.refreshCitations();       // v1.7.0：把回答里的引文回溯到材料
        this.saveHistory();            // v1.8.0：记进会话历史（有会话号才存）
      }
      let tail = "";
      if (usage) {
        tail = `（token：入 ${usage.inputTokens ?? "?"} / 出 ${usage.outputTokens ?? "?"}）`;
      }
      if (code !== 0 && code !== null && code !== undefined) {
        tail += `（dsh 退出码 ${code}）`;
      }
      if (tail) this.appendNote(tail);
      this.setStatus("完成");
    } catch (e) {
      this.setLast("");
      this.push("error", (e && e.message ? e.message : String(e)));
      this.setStatus("出错");
    } finally {
      this.setBusy(false);
    }
  },
};

window.addEventListener("load", () => DSHChat.init());
