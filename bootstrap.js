// DSH Bridge —— Zotero 7/8/9/10 插件（单文件版）
//
// 为什么全部逻辑都放在 bootstrap.js 里：
//   v1.0.4 实测日志显示 Services.scriptloader.loadSubScript(url, ctx) 卡住——
//   成功/失败都没有记录，且 catch 接不到异常。
//   而 bootstrap 作用域里 Zotero / Services / Components 本来就可用
//   （同一份日志里 await Zotero.initializationPromise 与 registerChrome 都成功了）。
//   → 所以不绕 loadSubScript，直接单文件。
//
// 运行位置：Zotero 的 bootstrap 沙箱。以下全局可用：
//   Zotero / Services / Components / ChromeUtils / Cc / Ci / Cu / APP_SHUTDOWN

/* eslint-disable no-undef */

var chromeHandle;
var DSHBridge;
var _wins = new Set();
var _chat = null;
// 注：v1.5.0 起进程句柄不再是模块级单变量 —— 改由串行闸门的 _running.proc 持有
// （原因见下方「串行闸门」一节的注释）。

// ---------- 自写日志（排查用；失败不影响主流程） ----------
//
// v1.3.1 三处改动：
//   ① 路径改为首选项 extensions.dshbridge.logPath（留空字符串 = 关闭文件日志）；
//      以前是硬编码路径，换机器/换目录即失效。
//   ② 超过 LOG_MAX_BYTES 自动轮转为 <路径>.1 —— 以前是无限增长。
//   ③ 通过 bridge.chatLog() 暴露给对话窗口，窗口侧不再各写一份路径常量。
const LOGFILE_DEFAULT = "";
const LOG_MAX_BYTES = 2 * 1024 * 1024;

// 注意：这里直接读 Zotero.Prefs，不走 getPref() ——
// 因为 getPref() 把空字符串当作"未设置"并回退到默认值，
// 而这里 "" 是有效语义（关闭文件日志）。
function logPath() {
  try {
    const p = Zotero.Prefs.get("extensions.dshbridge.logPath", true);
    if (typeof p === "string") return p.trim();
  } catch (e) {}          // 解析期 Zotero.Prefs 可能还没就绪
  return LOGFILE_DEFAULT;
}

function fileLog(msg) {
  try {
    const path = logPath();
    if (!path) return;    // 显式关闭
    const f = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    f.initWithPath(path);

    // 轮转：超限就把当前日志挪成 .1（moveTo 而非 copy+remove，避免半截文件）
    try {
      if (f.exists() && f.fileSize > LOG_MAX_BYTES) {
        const bak = f.clone();
        bak.leafName = f.leafName + ".1";
        try { if (bak.exists()) bak.remove(false); } catch (e) {}
        try { f.moveTo(bak.parent, bak.leafName); } catch (e) {}
        f.initWithPath(path);
      }
    } catch (e) {}

    const fos = Components.classes["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Components.interfaces.nsIFileOutputStream);
    fos.init(f, 0x02 | 0x08 | 0x10, parseInt("0666", 8), 0);   // WRONLY|CREATE|APPEND
    const cos = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
      .createInstance(Components.interfaces.nsIConverterOutputStream);
    cos.init(fos, "UTF-8");
    const d = new Date();
    const ts = d.toISOString().replace("T", " ").slice(0, 19);
    cos.writeString(`[${ts}] ${msg}\n`);
    cos.close();
  } catch (e) {}
}

function log(msg) {
  fileLog(msg);
  try { Zotero.debug("[DSH Bridge] " + msg); } catch (e) {}
}

// 脚本被解析时立刻记一行：用于区分「根本没被加载」与「加载了但 startup 没跑」
try { fileLog("=== bootstrap.js 解析 @ " + new Date().toString() + " ==="); } catch (e) {}

// ============================================================
//  生命周期
// ============================================================

function install(data, reason) { log(`install (reason=${reason})`); }

function uninstall(data, reason) { log(`uninstall (reason=${reason})`); }

async function startup({ id, version, resourceURI, rootURI }, reason) {
  log(`startup 进入  v=${version}  reason=${reason}`);
  await Zotero.initializationPromise;
  log("Zotero 初始化完成");

  if (!rootURI) rootURI = resourceURI.spec;
  log("rootURI = " + rootURI);

  let chromeOK = false;
  try {
    var aomStartup = Components.classes[
      "@mozilla.org/addons/addon-manager-startup;1"
    ].getService(Components.interfaces.amIAddonManagerStartup);
    chromeHandle = aomStartup.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
      ["content", "dshbridge", rootURI + "content/"],
    ]);
    chromeOK = true;
    log("chrome 注册成功");
  } catch (e) {
    log("**registerChrome 失败**：" + e);
  }

  DSHBridge = makeBridge({ id, version, rootURI, chromeRegistered: chromeOK });
  log("DSHBridge 已创建");

  Zotero.DSHBridge = DSHBridge;
  try {
    DSHBridge.init();
  } catch (e) {
    log("**init 失败**：" + e);
  }

  let n = 0;
  try {
    for (const win of Zotero.getMainWindows()) {
      if (!win.ZoteroPane) continue;
      try { DSHBridge.onMainWindowLoad(win); n++; }
      catch (e) { log("**onMainWindowLoad 失败**：" + e); }
    }
  } catch (e) {
    log("**遍历主窗口失败**：" + e);
  }
  log(`startup 完成（挂了 ${n} 个主窗口）`);

  // v1.5.0：阅读器集成（可被首选项 readerIntegration=false 关掉）
  try { registerReaderHooks(); } catch (e) { log("**注册阅读器钩子失败**：" + e); }

  // v1.8.0：设置面板
  try { registerPrefPane(rootURI); } catch (e) { log("**注册设置面板失败**：" + e); }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  log(`shutdown (reason=${reason})`);
  if (reason === APP_SHUTDOWN) return;
  try { unregisterReaderHooks(); } catch (e) {}
  try { unregisterPrefPane(); } catch (e) {}
  try { if (DSHBridge) DSHBridge.destroy(); } catch (e) { log("**destroy 出错**：" + e); }
  try { delete Zotero.DSHBridge; } catch (e) {}
  DSHBridge = undefined;
  if (chromeHandle) { try { chromeHandle.destruct(); } catch (e) {} chromeHandle = undefined; }
}

async function onMainWindowLoad({ window }, reason) {
  log("onMainWindowLoad 钩子");
  try {
    await Zotero.initializationPromise;
    if (DSHBridge) DSHBridge.onMainWindowLoad(window);
  } catch (e) { log("**钩子出错**：" + e); }
}

async function onMainWindowUnload({ window }, reason) {
  try { if (DSHBridge) DSHBridge.onMainWindowUnload(window); } catch (e) {}
}

// ============================================================
//  提示词组装
// ============================================================

function buildPrompt(ctx, q) {
  const head =
    "以下是从我的 Zotero 文献库中选出的材料。请基于这些材料回答我的问题。\n" +
    "注意：\n" +
    "1. 若材料不足以回答，请直接说明材料不足，不要编造。\n" +
    "2. 引用原文时请注明出自哪一篇，并给出页码线索。\n" +
    "3. 若用到你自身的检索工具（如 kb_search），请说明信息来源。\n\n";
  const body = ctx
    ? "===== 材料开始 =====\n" + ctx + "\n===== 材料结束 =====\n\n"
    : "";
  return head + body + "我的问题：" + q;
}

// ============================================================
//  串行闸门（v1.5.0；并发语义由主人裁定为「串行化」）
// ============================================================
// 为什么必须有：_proc 曾是模块级单变量。窗口正在跑时若从另一个入口
// （右键菜单、阅读器浮层）再发一次，_proc 被覆盖 → 先前那个进程的句柄丢失，
// abortCurrent() 永远 kill 不到它；而且两个请求会同时往同一棵消息树上写。
//
// 现在：任何时刻最多 1 个 DSH 子进程，其余按 FIFO 排队，队列长度可查。
// 「中止」的语义 = 杀掉正在跑的 + 清空排队中的
// （串行模型下"停止"应停掉全部待办；只杀当前会让队列接着跑，与直觉不符）。
let _running = null;   // { id, proc } —— proc 在 spawn 成功后填入
let _waiters = [];     // [{ id, resolve, reject }]
let _reqSeq = 0;

function queueDepth() { return _waiters.length; }

function acquireSlot(onQueued) {
  return new Promise((resolve, reject) => {
    const id = ++_reqSeq;
    if (!_running) { _running = { id, proc: null }; resolve(id); return; }
    _waiters.push({ id, resolve, reject });
    if (typeof onQueued === "function") {
      try { onQueued(_waiters.length); } catch (e) {}
    }
  });
}

function releaseSlot() {
  const next = _waiters.shift();
  if (next) { _running = { id: next.id, proc: null }; next.resolve(next.id); }
  else { _running = null; }
}

// 清空队列；被清掉的调用者会收到 reject（不能让它们的 await 永远挂着）
function clearQueue() {
  const q = _waiters;
  _waiters = [];
  for (const w of q) { try { w.reject(new Error("ABORTED")); } catch (e) {} }
  return q.length;
}

// ============================================================
//  阅读器集成（v1.5.0 · P2）
// ============================================================
// 已核实（读 C:\Program Files\Zotero\app\omni.ja 的 xpcom/reader.js）：
//   · 合法事件**只有 8 种**，renderSidebar **不在其中**
//     （旧提案 DSH_Bridge扩展提案_20261014.md §1.1 那条写法会**静默失败**）
//   · 签名 registerEventListener(type, handler, pluginID)
//   · reader.js 里存在 `shutdown: ({ id: pluginID }) => this._unregisterEventListenerByPluginID(pluginID)`
//     这一钩子（签名即插件的 shutdown 回调形式）—— 所以 pluginID **必须传**，不传就永远清不掉
//   · 分发是同步的：内层 reader 派发 customEvent → 外层包上 reader/append → _dispatchEvent
//   · append 的参数会被 Components.utils.cloneInto 克隆进内层文档
//     ⇒ 注入的 DOM 不在本插件文档里，**chat.css 不生效**，样式必须内联
//   · ⚠️ 监听器能否跨 cloneInto 存活，**我无法在静态层面确证**
//     → 见 appendAndBind()：注入后按 id 把内层文档里真正生效的节点取回来重绑，
//       并把「是不是同一个对象」写进日志。第一次装上去，日志就会回答这个问题。

let _readerRegistered = false;

function readerDoc(ev) {
  try { if (ev && ev.doc && ev.doc.createElement) return ev.doc; } catch (e) {}
  try {
    const w = ev && ev.reader && ev.reader._iframeWindow;
    if (w && w.document && w.document.createElement) return w.document;
  } catch (e) {}
  return null;
}

function selectedTextOf(ev) {
  try {
    const a = ev && ev.params && ev.params.annotation;
    if (a && typeof a.text === "string") return a.text;
  } catch (e) {}
  try {
    const t = ev && ev.params && ev.params.text;
    if (typeof t === "string") return t;
  } catch (e) {}
  return "";
}

/**
 * 注入节点，并**确保它可点**。
 * append 的参数会被 cloneInto 克隆进内层文档，先绑的监听器未必跟得过去；
 * 所以延时按 id 把内层文档里真正生效的节点取回来，再绑一次。
 * 日志里那行「是同一对象=?」就是用来回答"监听器到底有没有活下来"的。
 * @param {Object} bindMap  { elementId: handler }
 */
function appendAndBind(ev, node, bindMap) {
  if (!node) return false;
  try { ev.append(node); }
  catch (e) { log("[reader] append 失败：" + e); return false; }
  setTimeout(() => {
    let doc = null;
    try { doc = readerDoc(ev); } catch (e) {}
    if (!doc || !doc.getElementById) { log("[reader] 二次绑定：拿不到 document"); return; }

    // v1.6.1 修正：原来把「是不是同一对象」写在 for 循环里、用 id === selfId 判定，
    // 但 bindMap 的键是**按钮**的 id，而 selfId 是**容器**的 id —— 条件永远不成立，
    // 这行日志因此从未打印过（v1.5.0 实机验证时被我误读成"事件没触发"）。
    // 现在容器单独判一次。
    const selfId = node.getAttribute && node.getAttribute("id");
    if (selfId) {
      const selfLive = doc.getElementById(selfId);
      if (!selfLive) log(`[reader] 二次绑定：容器 #${selfId} 不在内层文档里`);
      else log(`[reader] #${selfId} 是同一对象=${selfLive === node}`);
    }

    for (const id of Object.keys(bindMap)) {
      const live = doc.getElementById(id);
      if (!live) { log(`[reader] 二次绑定：找不到 #${id}`); continue; }
      try {
        live.addEventListener("click", (e) => {
          try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
          bindMap[id]();
        });
      } catch (e) { log(`[reader] 绑 #${id} 失败：` + e); }
    }
  }, 0);
  return true;
}

/** 内层文档里的按钮 —— 样式全内联，因为那里没有我们的 CSS */
function readerButton(doc, id, label, title) {
  const b = doc.createElement("button");
  b.setAttribute("id", id);
  b.setAttribute("type", "button");
  if (title) b.setAttribute("title", title);
  b.textContent = label;
  b.style.cssText =
    "font:12px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;"
    + "margin:2px 4px 2px 0;padding:2px 8px;"
    + "border:1px solid rgba(128,128,128,.45);border-radius:6px;"
    + "background:rgba(127,127,127,.10);color:inherit;cursor:pointer;";
  return b;
}

/**
 * 问 Zotero 自己：本插件的监听器是不是已经在了。
 * 读的是 reader.js 里的 `_registeredListeners`（**私有字段**，尽力而为）——
 * 拿不到就返回 false，让调用方照常注册（宁可有重复，也不要整个功能不工作）。
 */
function readerListenerExists(pid) {
  try {
    const L = Zotero.Reader && Zotero.Reader._registeredListeners;
    if (Array.isArray(L)) return L.some((x) => x && x.pluginID === pid);
  } catch (e) {}
  return false;
}

function registerReaderHooks() {
  if (_readerRegistered) return;
  if (!(Zotero.Reader && Zotero.Reader.registerEventListener)) {
    log("[reader] Zotero.Reader.registerEventListener 不存在，跳过");
    return;
  }
  if (Zotero.Prefs.get("extensions.dshbridge.readerIntegration", true) === false) {
    log("[reader] 首选项 readerIntegration=false，跳过注册");
    return;
  }
  const PID = "dsh-bridge@local.example";

  // v1.6.1：防重复注册。
  // 实机日志显示：6 轮注册只有 1 次清理，且同一秒出现两条一模一样的「划词触发」
  // —— 说明监听器在累积，_dispatchEvent 会逐个调用，于是每次事件跑 N 遍。
  // 根因：_readerRegistered 是模块变量，插件作用域一重建就归零；
  //       Zotero 的按 pluginID 清理只在 shutdown 路径上跑，覆盖不了所有情形。
  // 所以这里再问 Zotero 本人一次（私有字段，尽力而为）。
  if (readerListenerExists(PID)) {
    log("[reader] Zotero.Reader 里已有本插件的监听器，跳过重复注册");
    _readerRegistered = true;
    return;
  }

  // ---- ① 划词浮层（最高价值的一个）----
  try {
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", (ev) => {
      try {
        const doc = readerDoc(ev);
        if (!doc) { log("[reader] 划词：拿不到内层 document"); return; }
        const text = selectedTextOf(ev);
        log("[reader] 划词触发；" + text.length + " 字；params="
            + (ev && ev.params ? Object.keys(ev.params).join(",") : "(无)"));
        if (!text.trim()) return;

        const bar = doc.createElement("div");
        bar.setAttribute("id", "dshbridge-selbar");
        bar.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:2px;padding:2px 0;";

        const actions = [
          ["ask", "问 DSH", "把选中文字发给 DSH", (t) => t],
          ["explain", "解释", "让 DSH 解释这段",
            (t) => "请解释这段话的意思，以及它在全文论证里的作用：\n\n" + t],
          ["critique", "批判", "让 DSH 挑这段的毛病",
            (t) => "请以审稿人的立场指出这段话在论证上的薄弱之处，以及可以怎样反驳：\n\n" + t],
        ];
        const bindMap = {};
        for (const [suffix, label, title, mkQ] of actions) {
          const id = "dshbridge-sel-" + suffix;
          bar.appendChild(readerButton(doc, id, label, title));
          bindMap[id] = () => {
            log("[reader] 划词动作点击：" + label);
            try { DSHBridge.askFromReader(mkQ(text), ev.reader); }
            catch (e) { log("[reader] 动作出错：" + e); }
          };
        }
        appendAndBind(ev, bar, bindMap);
      } catch (e) { log("[reader] 划词处理器出错：" + e); }
    }, PID);
    log("[reader] 已注册 renderTextSelectionPopup");
  } catch (e) { log("[reader] 注册划词失败：" + e); }

  // ---- ② 阅读器工具栏 ----
  // 侧栏面板在 Zotero 9.0.6 没有公开注册点（已证），工具栏按钮是替代入口
  try {
    Zotero.Reader.registerEventListener("renderToolbar", (ev) => {
      try {
        const doc = readerDoc(ev);
        if (!doc) { log("[reader] 工具栏：拿不到内层 document"); return; }
        log("[reader] renderToolbar 触发");
        const wrap = doc.createElement("div");
        wrap.setAttribute("id", "dshbridge-toolbar");
        wrap.style.cssText = "display:inline-flex;align-items:center;";
        const id = "dshbridge-toolbar-btn";
        wrap.appendChild(readerButton(doc, id, "DSH", "打开 DSH 对话窗口"));
        appendAndBind(ev, wrap, {
          [id]: () => {
            log("[reader] 工具栏按钮点击");
            try { DSHBridge.openChat(Zotero.getMainWindow()); }
            catch (e) { log("[reader] 打开窗口失败：" + e); }
          },
        });
      } catch (e) { log("[reader] 工具栏处理器出错：" + e); }
    }, PID);
    log("[reader] 已注册 renderToolbar");
  } catch (e) { log("[reader] 注册工具栏失败：" + e); }

  // ---- ③ 批注侧栏头部 ----
  try {
    Zotero.Reader.registerEventListener("renderSidebarAnnotationHeader", (ev) => {
      try {
        const doc = readerDoc(ev);
        if (!doc) { log("[reader] 批注侧栏：拿不到内层 document"); return; }
        log("[reader] renderSidebarAnnotationHeader 触发");
        const id = "dshbridge-annhead";
        const b = readerButton(doc, id, "问 DSH", "把这条批注作为提问材料");
        appendAndBind(ev, b, {
          [id]: () => {
            const t = selectedTextOf(ev);
            log("[reader] 批注侧栏入口点击；带出 " + t.length + " 字");
            try {
              DSHBridge.askFromReader(
                t ? ("请解释这条批注：\n\n" + t) : "请就这条批注展开说明。", ev.reader);
            } catch (e) { log("[reader] 出错：" + e); }
          },
        });
      } catch (e) { log("[reader] 批注侧栏处理器出错：" + e); }
    }, PID);
    log("[reader] 已注册 renderSidebarAnnotationHeader");
  } catch (e) { log("[reader] 注册批注侧栏失败：" + e); }

  _readerRegistered = true;
}

function unregisterReaderHooks() {
  if (!_readerRegistered) return;
  // 我们注册时传的是内联箭头函数，拿不到 handler 引用，因此无法调
  // unregisterEventListener(type, handler)。两条清理路径：
  //   ① Zotero 在插件 shutdown 时按 pluginID 注销（已核实 reader.js 里有这条钩子）
  //   ② 下次注册时由 readerListenerExists() 拦住重复
  log("[reader] 阅读器钩子交由 Zotero 按 pluginID 清理；下次注册前会先查重");
  _readerRegistered = false;
}

// ============================================================
//  工作区（v1.6.0）
// ============================================================
// 已核实两件事：
//   ① DSH 的"工作区"就是**进程的当前工作目录** ——
//      dsh 包 lib/plugin-BGnVfe_D.js 第 78 行写着 `cwd: process.cwd()`，
//      且 `dsh --help` 里**没有** --workspace 之类的选项。
//   ② 插件 spawn 出来的 dsh 继承的是 **Zotero 进程的 cwd**，不是你想要的目录。
//      所以在此之前，每次会话跑的都是 Zotero 的工作目录。
// 修法：Zotero 自带的 Subprocess.sys.mjs 支持 `options.workdir`
//      （其 JSDoc 有 `@param {string} [options.workdir]`，实现里有 `options.workdir = options.workdir || null`）。

/** 读一个 UTF-8 文本文件；不存在返回 null。读法与 fileLog 的流写法镜像。 */
function readTextFile(path) {
  try {
    const f = Components.classes["@mozilla.org/file/local;1"]
      .createInstance(Components.interfaces.nsIFile);
    f.initWithPath(path);
    if (!f.exists()) return null;
    const fis = Components.classes["@mozilla.org/network/file-input-stream;1"]
      .createInstance(Components.interfaces.nsIFileInputStream);
    fis.init(f, -1, -1, 0);
    const cis = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
      .createInstance(Components.interfaces.nsIConverterInputStream);
    cis.init(fis, "UTF-8", 4096, 0);
    let data = "";
    const chunk = { value: "" };
    while (cis.readString(4096, chunk) > 0) data += chunk.value;
    cis.close();
    return data;
  } catch (e) { log("[file] 读失败 " + path + "：" + e); return null; }
}

/** 覆盖写一个 UTF-8 文本文件（0x20 = TRUNCATE） */
function writeTextFile(path, text) {
  const f = Components.classes["@mozilla.org/file/local;1"]
    .createInstance(Components.interfaces.nsIFile);
  f.initWithPath(path);
  const fos = Components.classes["@mozilla.org/network/file-output-stream;1"]
    .createInstance(Components.interfaces.nsIFileOutputStream);
  fos.init(f, 0x02 | 0x08 | 0x20, parseInt("0666", 8), 0);
  const cos = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
    .createInstance(Components.interfaces.nsIConverterOutputStream);
  cos.init(fos, "UTF-8");
  cos.writeString(text);
  cos.close();
}

function workspaceRegistryPath() {
  try {
    const p = Zotero.Prefs.get("extensions.dshbridge.workspaceRegistry", true);
    if (typeof p === "string" && p.trim()) return p.trim();
  } catch (e) {}
  // 默认：从家目录拼出 ~/.dsh/storages/workspace.json
  // （不写死用户名 —— 换机器/换账户即失效）
  try {
    const home = Components.classes["@mozilla.org/file/directory_service;1"]
      .getService(Components.interfaces.nsIProperties)
      .get("Home", Components.interfaces.nsIFile);
    const f = home.clone();
    f.append(".dsh"); f.append("storages"); f.append("workspace.json");
    return f.path;
  } catch (e) { return ""; }
}

/** 读 DSH 的工作区登记表，返回 [{ title, path }]（按标题排序） */
function listWorkspaces() {
  const out = [];
  try {
    const path = workspaceRegistryPath();
    if (!path) return out;
    const data = readTextFile(path);
    if (data == null) { log("[ws] 登记表不存在：" + path); return out; }

    const j = JSON.parse(data);
    const ws = j && j.tables && j.tables.workspaces;
    if (ws) {
      for (const k of Object.keys(ws)) {
        const w = ws[k];
        if (w && w.path) out.push({ title: w.title || w.path, path: w.path });
      }
    }
    out.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh"));
  } catch (e) { log("[ws] 读登记表失败：" + e); }
  return out;
}

/** Zotero 进程自己的 cwd —— 未指定工作区时，dsh 就跑在这里 */
function zoteroCwd() {
  try {
    return Components.classes["@mozilla.org/file/directory_service;1"]
      .getService(Components.interfaces.nsIProperties)
      .get("CurWorkD", Components.interfaces.nsIFile).path;
  } catch (e) { return "(取不到)"; }
}

// ============================================================
//  设置面板（v1.8.0）
// ============================================================
// 已核（读 xpcom/preferencePanes.js）：
//   · PreferencePanes.register(options) 与 unregister(id) 都在
//   · 缺 pluginID 或 src 会直接 throw
//   · src / scripts / stylesheets 都过 Zotero.Plugins.resolveURI(pluginID, uri)
//     其 JSDoc 官例用的是 **rootURI + '文件名'** 这种绝对写法 —— 这里照此办理
//   · id 不给的话默认叫 `plugin-pane-<随机串>-<pluginID>`，事后清不掉 → 必须显式给
let _prefPaneID = null;

async function registerPrefPane(rootURI) {
  if (!(Zotero.PreferencePanes && Zotero.PreferencePanes.register)) {
    log("[pref] 本版 Zotero 没有 PreferencePanes.register，跳过设置面板");
    return;
  }
  if (_prefPaneID) { log("[pref] 设置面板已注册过，跳过"); return; }
  // v1.9.1：id 是写死的，而 _prefPaneID 是模块变量、作用域一重建就归零 ——
  // 先按 id 清一次，避免同一个 id 重复注册（注册两遍的行为未定义）。
  try { Zotero.PreferencePanes.unregister("dshbridge-pane"); } catch (e) {}
  try {
    const id = await Zotero.PreferencePanes.register({
      pluginID: "dsh-bridge@local.example",
      src: rootURI + "content/preferences.xhtml",
      id: "dshbridge-pane",
      scripts: [rootURI + "content/preferences.js"],
    });
    _prefPaneID = id;
    log("[pref] 已注册设置面板：" + id);
  } catch (e) {
    log("[pref] **注册设置面板失败**：" + e);
  }
}

function unregisterPrefPane() {
  if (!_prefPaneID) return;
  try { Zotero.PreferencePanes.unregister(_prefPaneID); log("[pref] 已注销设置面板"); }
  catch (e) { log("[pref] 注销设置面板失败：" + e); }
  _prefPaneID = null;
}

// ============================================================
//  预设动作（单一真源）
// ============================================================
// v1.4.0：从 onMainWindowLoad 里提出来。右键菜单与对话窗口的快捷卡片
// 都读这一份，避免两处维护导致"菜单里有、窗口里没有"。
function presets() {
  return [
    ["概括核心论点与分歧",
     "请概括这几篇文献各自的核心论点，指出它们之间的分歧，并说明分歧的根源。"],
    ["列出可引用的关键句（带页码线索）",
     "请从材料中挑出最值得引用的关键句，逐条列出，并注明出自哪一篇、以及页码线索。"],
    ["找出方法论差异",
     "请比较这几篇文献在研究方法上的差异，并说明各自的适用边界。"],
    ["对我的研究有什么启发",
     "假设我在研究中国近代思想史（尤其梁漱溟与乡村建设），这几篇材料对我在问题意识、论证角度或史料上有哪些启发？"],
    ["挑毛病：论证薄弱处",
     "请以审稿人的立场，指出这几篇材料在论证上最薄弱的环节，以及若要反驳它们可以从哪里入手。"],
    ["与我的知识库对话",
     "请用 kb_search 在我的文献库里检索这些文献涉及的关键概念，说明库内还有哪些相关材料。"],
  ];
}

// ============================================================
//  主体
// ============================================================

function makeBridge({ id, version, rootURI, chromeRegistered }) {
  return {
    id, version, rootURI, chromeRegistered,

    defaults: {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      dshBin: "",
      profile: "dshbridge",
      timeoutSec: 600,
      maxFulltextChars: 60000,
      includeFulltext: true,
    },

    getPref(key) {
      try {
        const v = Zotero.Prefs.get("extensions.dshbridge." + key, true);
        if (v === undefined || v === null || v === "") return this.defaults[key];
        return v;
      } catch (e) { return this.defaults[key]; }
    },

    chatURL() {
      return this.chromeRegistered
        ? "chrome://dshbridge/content/chat.xhtml"
        : this.rootURI + "content/chat.xhtml";
    },

    // 供对话窗口调用（窗口是独立文档，拿不到本文件的私有函数）
    buildPrompt(ctx, q) { return buildPrompt(ctx, q); },

    // v1.3.1：把日志也让给窗口用，窗口侧不再各写一份路径常量
    chatLog(msg) { log("[窗口] " + msg); },

    // v1.4.0：窗口的快捷动作卡片直接读这份预设 —— 与右键菜单同源，避免两处漂移
    presets() { return presets(); },

    init() {
      log("init " + version);
      log("chatURL=" + this.chatURL());
      log("node=" + this.getPref("nodePath"));
      log("dsh =" + this.getPref("dshBin"));
    },

    // ---------- 菜单 ----------
    onMainWindowLoad(win) {
      if (!win || _wins.has(win)) return;
      const doc = win.document;

      const itemmenu = doc.getElementById("zotero-itemmenu");
      if (itemmenu && !doc.getElementById("dshbridge-itemmenu")) {
        try {
          const sep = doc.createXULElement("menuseparator");
          sep.id = "dshbridge-sep";
          const mi = doc.createXULElement("menuitem");
          mi.id = "dshbridge-itemmenu";
          mi.setAttribute("label", "用 DSH 处理");
          const popup = doc.createXULElement("menupopup");
          mi.appendChild(popup);

          // 预设动作（参考 AI Paper Chat / llm-for-zotero 的常用动作）
          // v1.4.0：改为模块级 presets() —— 右键菜单与对话窗口的快捷卡片共用一份，
          // 不再各存一份（改之前这 6 条只存在于右键菜单，窗口里根本看不到）。
          for (const [label, q] of presets()) {
            const it = doc.createXULElement("menuitem");
            it.setAttribute("label", label);
            it.addEventListener("command", () => this.onAsk(win, q));
            popup.appendChild(it);
          }
          const sep2 = doc.createXULElement("menuseparator");
          popup.appendChild(sep2);
          const custom = doc.createXULElement("menuitem");
          custom.setAttribute("label", "自定义问题…");
          custom.addEventListener("command", () => this.onAsk(win, null));
          popup.appendChild(custom);

          // 独立入口：打开空白对话窗口
          const sep3 = doc.createXULElement("menuseparator");
          sep3.id = "dshbridge-sep2";
          const chatOnly = doc.createXULElement("menuitem");
          chatOnly.id = "dshbridge-chatonly";
          chatOnly.setAttribute("label", "打开对话窗口");
          chatOnly.addEventListener("command", () => this.openChat(win));
          itemmenu.appendChild(sep);
          itemmenu.appendChild(mi);
          itemmenu.appendChild(sep3);
          itemmenu.appendChild(chatOnly);
          log("已注入条目右键菜单（6 个预设 + 自定义）");
        } catch (e) { log("**注入条目菜单失败**：" + e); }
      } else if (!itemmenu) {
        log("**找不到 zotero-itemmenu 元素**");
      }

      const tools = doc.getElementById("menu_ToolsPopup");
      if (tools && !doc.getElementById("dshbridge-tools")) {
        try {
          const sep = doc.createXULElement("menuseparator");
          sep.id = "dshbridge-tools-sep";
          const mi = doc.createXULElement("menuitem");
          mi.id = "dshbridge-tools";
          mi.setAttribute("label", "DSH 对话窗口");
          mi.addEventListener("command", () => this.openChat(win));
          tools.appendChild(sep);
          tools.appendChild(mi);
          log("已注入工具菜单");
        } catch (e) { log("**注入工具菜单失败**：" + e); }
      }

      _wins.add(win);
    },

    onMainWindowUnload(win) { _wins.delete(win); },

    destroy() {
      for (const win of Array.from(_wins)) {
        try {
          const doc = win.document;
          // v1.3.1：补上 dshbridge-sep2 —— v1.3.0 注入时给了它 id（见下方 sep3），
          // 却漏在这个清理列表里，导致禁用/卸载插件后条目右键菜单残留一条分隔线。
          for (const eid of ["dshbridge-itemmenu", "dshbridge-sep", "dshbridge-sep2",
                             "dshbridge-tools", "dshbridge-tools-sep"]) {
            const el = doc.getElementById(eid);
            if (el) el.remove();
          }
        } catch (e) {}
      }
      _wins.clear();
      this.abortCurrent();
      if (_chat && !_chat.closed) { try { _chat.close(); } catch (e) {} }
      _chat = null;
    },

    // ---------- 上下文 ----------
    selectedItems() {
      try {
        const win = Zotero.getMainWindow();
        const pane = win.ZoteroPane || Zotero.getActiveZoteroPane();
        return pane.getSelectedItems();
      } catch (e) { log("selectedItems 失败：" + e); return []; }
    },

    // v1.3.1：改成「元数据 → 并行取全文 → 按序装配」三段。
    // v1.3.0 在 for 循环里逐篇 await attachmentText，多选文献时是串行等待
    // （选 10 篇等 10 次）；取全文彼此独立，可以并行。
    // 装配顺序、截断口径（先到先得、剩余 ≤500 字则整篇略去）与 v1.3.0 逐字一致。
    //
    // v1.4.0：改名为 collectContextDetailed 并返回 { text, report }。
    // report 供对话窗口的"材料面板"逐条展示 —— 截断是"先到先得"的，
    // 选 5 篇时第 5 篇可能整篇被略去，此前窗口只显示一行"N 条 / M 字"，
    // 用户看不到模型究竟拿到了什么。
    async collectContextDetailed(items, opts = {}) {
      const withFulltext = opts.fulltext !== false;
      const cap = Number(this.getPref("maxFulltextChars")) || 60000;

      // ① 解析元数据与目标附件（同步）
      const rows = items.map((item) => {
        let target = item;
        if (item.isAttachment() && item.parentItemID) {
          target = Zotero.Items.get(item.parentItemID);
        }
        const isRegular = target && target.isRegularItem();
        const title = isRegular ? target.getField("title")
                                : (item.getField ? item.getField("title") : "(无题)");
        const year = isRegular ? (target.getField("date") || "") : "";
        const creators = isRegular
          ? target.getCreators().map(c => `${c.lastName || ""}${c.firstName || ""}`).join("、")
          : "";
        const pub = isRegular
          ? (target.getField("publicationTitle") || target.getField("publisher") || "") : "";
        const doi = isRegular ? (target.getField("DOI") || "") : "";

        let block = `【文献】${title}\n`;
        if (creators) block += `作者：${creators}\n`;
        if (year) block += `年份：${year}\n`;
        if (pub) block += `出处：${pub}\n`;
        if (doi) block += `DOI：${doi}\n`;

        let att = null;
        if (withFulltext) {
          if (item.isAttachment()) att = item;
          else if (isRegular) {
            for (const aid of target.getAttachments()) {
              const a = Zotero.Items.get(aid);
              if (a && a.attachmentContentType === "application/pdf") { att = a; break; }
            }
          }
        }
        return { block, att, title, itemID: (isRegular ? target.id : (item.id || null)) };
      });

      // ② 并行取全文（各篇独立成败，互不牵连）
      const texts = await Promise.all(rows.map(async (r) => {
        if (!r.att) return null;    // 没有 PDF 附件 → 不加任何说明（同 v1.3.0）
        try {
          const t = await r.att.attachmentText;
          return (t && t.trim()) ? { ok: true, text: t } : { ok: false, empty: true };
        } catch (e) {
          return { ok: false, err: (e && e.message) ? e.message : String(e) };
        }
      }));

      // ③ 按原顺序装配，并施加总长度上限
      let used = 0;
      const report = [];
      const parts = rows.map((r, i) => {
        let block = r.block;
        const t = texts[i];
        if (!t) {
          // 没有 PDF 附件 → 只带元数据
          report.push({ itemID: r.itemID, title: r.title, chars: 0,
                        state: withFulltext ? "no-pdf" : "meta-only" });
          return block;
        }
        if (!t.ok) {
          block += t.empty
            ? "\n（该附件没有全文索引——可能是未 OCR 的扫描件）\n"
            : `\n（取全文失败：${t.err}）\n`;
          report.push({ itemID: r.itemID, title: r.title, chars: 0,
                        state: t.empty ? "no-index" : "error", err: t.err });
          return block;
        }
        const remain = cap - used;
        if (remain > 500) {
          const slice = t.text.slice(0, remain);
          block += `\n全文（${t.text.length} 字，截取前 ${slice.length} 字）：\n"""\n${slice}\n"""\n`;
          used += slice.length;
          report.push({
            itemID: r.itemID, title: r.title, chars: slice.length, total: t.text.length,
            state: slice.length < t.text.length ? "partial" : "full",
            // v1.7.0：把**实际发出去的这段正文**留在报告里 ——
            // 引文核对面板要用它来把回答里的引文回溯到具体文献。
            text: slice,
          });
        } else {
          block += "\n（全文因长度上限略去）\n";
          report.push({ itemID: r.itemID, title: r.title, chars: 0,
                        total: t.text.length, state: "omitted" });
        }
        return block;
      });

      return { text: parts.join("\n" + "-".repeat(50) + "\n"), report };
    },

    // 兼容旧调用点（右键菜单的 onAsk 等）：只要字符串
    async collectContext(items, opts = {}) {
      const r = await this.collectContextDetailed(items, opts);
      return r.text;
    },

    // ---------- 调 DSH ----------
    // v1.3.1：返回「是否真有进程被 kill」。v1.3.0 无论有没有在跑，
    // 窗口都提示「子进程已被 kill」—— 提示语与事实不符。
    // v1.5.0：串行化以后，中止 = 杀正在跑的 + 清空排队中的，故返回对象。
    abortCurrent(opts) {
      // clearQueueToo 默认为 true（"中止"按钮的语义 = 停掉全部待办）；
      // 超时路径会显式传 false —— 超时不是用户中止，排在他后面的请求不该被连坐。
      const clearToo = !(opts && opts.clearQueueToo === false);
      let killed = false;
      if (_running && _running.proc) {
        try { _running.proc.kill(); killed = true; } catch (e) {}
        _running.proc = null;
      }
      const dropped = clearToo ? clearQueue() : 0;
      return { killed, dropped };
    },

    queueDepth() { return queueDepth(); },

    /**
     * v1.5.0 串行闸门包一层。任何时刻只有一个 DSH 子进程在跑，
     * 其余在 acquireSlot 里 FIFO 排队。
     * ⚠️ 名额必须在这个**外层** finally 释放：放内层的话，
     *    「spawn 失败直接 throw」这条路径会漏放，队列从此死锁。
     */
    async runDSH(prompt, opts = {}) {
      try {
        await acquireSlot(opts.onQueued);
      } catch (e) {
        throw new Error("请求已中止（当时还在排队中）");
      }
      try {
        return await this._runDSHInner(prompt, opts);
      } finally {
        releaseSlot();
      }
    },

    async _runDSHInner(prompt, { onChunk, onEvent, sessionId } = {}) {
      let Subprocess;
      try {
        ({ Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs"));
      } catch (e) {
        throw new Error("取不到 Subprocess 模块：" + e);
      }

      const node = this.getPref("nodePath");
      const bin = this.getPref("dshBin");
      const profile = this.getPref("profile");

      // 用 --json：能拿到 sessionId（供续接）、status（进度）、usage（token）
      const args = [bin, "--profile", profile, "--json", "-"];
      if (sessionId) args.splice(args.length - 1, 0, "--session-id", sessionId);

      // v1.6.0：工作区 = 子进程的 cwd（已核实 dsh 用 process.cwd()）。
      // 不指定时 dsh 跑在 Zotero 的 cwd 里 —— 把那值也一并记进日志，便于对照。
      const wsPath = String(this.getPref("workspace") || "").trim();
      const callOpts = { command: node, arguments: args, stderr: "pipe" };
      if (wsPath) callOpts.workdir = wsPath;

      log("spawn: " + node + " " + args.join(" ")
          + "  ｜ 工作区=" + (wsPath || (zoteroCwd() + "（未指定，Zotero 的 cwd）")));

      let proc;
      try {
        proc = await Subprocess.call(callOpts);
      } catch (e) {
        throw new Error(`启动失败：${e}\n请检查首选项 extensions.dshbridge.nodePath（当前：${node}）`
          + (wsPath ? `\n以及工作区路径是否确实存在：${wsPath}` : ""));
      }
      if (_running) _running.proc = proc;   // 挂到当前名额上，供 abortCurrent 杀

      // v1.11.0：**必须**并发读走 stderr。两个理由：
      //   ① 诊断：报错（如 MISSING_CREDENTIAL）原本到不了用户，界面只说"没有返回内容"；
      //   ② 安全：stderr 管道写满 64KB，子进程会阻塞 —— 那就成了死等。
      // 只留尾部 4000 字符（够看清错因，又不至于把插件日志灌满）。
      let errBuf = "";
      const drainErr = (async () => {
        try {
          while (true) {
            const s = await proc.stderr.readString();
            if (!s) break;
            if (errBuf.length < 64000) errBuf += s;
            else errBuf = errBuf.slice(-32000) + s;
          }
        } catch (e) {}
      })();

      try { proc.stdin.write(prompt); } catch (e) { throw new Error("写 stdin 失败：" + e); }
      try { await proc.stdin.close(); } catch (e) {}

      let buf = "";          // NDJSON 行缓冲
      let acc = "";          // 累积的正文
      let finalText = null;  // final 事件里的权威文本
      let sid = sessionId || null;
      let usage = null;
      let phase = "";

      const handle = (ev) => {
        try {
          if (ev.type === "session" && ev.sessionId) {
            sid = ev.sessionId;
          } else if (ev.type === "text") {
            acc += (ev.text || "");
            if (onChunk) onChunk(acc);
          } else if (ev.type === "final") {
            finalText = ev.text || acc;
          } else if (ev.type === "status") {
            if (ev.phase === "step_start") {
              phase = `第 ${ev.turn || "?"} 轮 · 第 ${ev.step || "?"} 步`;
            } else if (ev.phase === "step_end" && ev.usage) {
              // v1.9.2：**累加**而不是覆盖。
              // 旧写法 `usage = ev.usage` 只留最后一步 —— 窗口显示的是「最后一步」的用量，
              // 多步 agent 运行下会小得离谱（实测出现过 token(in=359)，
              // 我还据此推断"全文没进去"——那个推断很可能是错的，错因就在这里）。
              const u0 = usage || { inputTokens: 0, outputTokens: 0, steps: 0 };
              usage = {
                inputTokens: (u0.inputTokens || 0) + (ev.usage.inputTokens || 0),
                outputTokens: (u0.outputTokens || 0) + (ev.usage.outputTokens || 0),
                steps: (u0.steps || 0) + 1,
              };
            }
          }
          if (onEvent) {
            try { onEvent({ ...ev, sessionId: sid, usage, phase }); } catch (e) {}
          }
        } catch (e) {
          log("事件处理出错：" + e);
        }
      };

      const timer = setTimeout(() => {
        log("超时，kill");
        // 只杀当前这一个，不动队列（见 abortCurrent 的注释）
        this.abortCurrent({ clearQueueToo: false });
      }, (Number(this.getPref("timeoutSec")) || 600) * 1000);
      try {
        while (true) {
          let s;
          try { s = await proc.stdout.readString(); } catch (e) { break; }
          if (!s) break;
          buf += s;
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { handle(JSON.parse(line)); }
            catch (e) { log("非 JSON 行（忽略）：" + line.slice(0, 120)); }
          }
        }
        // 收尾：缓冲里可能还剩一行
        const rest = buf.trim();
        if (rest) {
          try { handle(JSON.parse(rest)); } catch (e) {}
        }
      } finally {
        clearTimeout(timer);
        // 名额由外层 runDSH 的 finally 释放（见那里的注释），这里只摘掉进程句柄
        if (_running) _running.proc = null;
      }

      let code = null;
      try {
        const r = await proc.wait();
        code = (typeof r === "number") ? r
             : (r && typeof r === "object")
               ? (r.exitCode ?? r.exitStatus ?? r.code ?? JSON.stringify(r))
               : r;
      } catch (e) {}

      try { await drainErr; } catch (e) {}   // 进程已退出 → stderr 到 EOF，收干净

      const text = finalText !== null ? finalText : acc;
      const errTail = errBuf.trim().slice(-4000);
      log(`dsh 结束 code=${code} 会话=${sid} 输出 ${text.length} 字` +
          (usage ? ` token(in=${usage.inputTokens},out=${usage.outputTokens})` : "") +
          (errTail ? ` ｜ stderr ${errTail.length} 字` : ""));
      // v1.9.0：把**本次真正用的工作区**随结果带出去。
      // 为什么必须带：会话落在哪个桶是由 **spawn 那一刻的 workdir** 决定的，
      // 而登记若临时再读一次首选项，用户在运行期间切了工作区就会
      // 「登记到 A、文件却在 B」—— 界面里点开是空的。
      // v1.11.0：带上 stderr 尾部 —— 失败时把真正的错因交给界面显示。
      return { text, code, sessionId: sid, usage, workspace: wsPath, stderrTail: errTail };
    },

    // ---------- 交互 ----------
    // preset == null → 弹框让用户自己写；preset 是字符串 → 直接用它
    async onAsk(win, preset) {
      const pane = win.ZoteroPane || Zotero.getActiveZoteroPane();
      const items = pane.getSelectedItems();
      if (!items.length) {
        Services.prompt.alert(win, "DSH Bridge", "请先选中至少一条文献。");
        return;
      }

      let q;
      if (typeof preset === "string" && preset) {
        q = preset;
      } else {
        const question = { value: "" };
        const ok = Services.prompt.prompt(
          win, "用 DSH 处理",
          `已选中 ${items.length} 条。\n\n要 DSH 做什么？\n（留空则默认：概括核心论点与分歧）`,
          question, null, { value: false }
        );
        if (!ok) return;
        q = (question.value || "").trim() ||
          "请概括这几篇文献的核心论点，指出它们之间的分歧，并列出可引用的关键句（带页码线索）。";
      }

      const detailed = await this.collectContextDetailed(items, {
        fulltext: this.getPref("includeFulltext"),
      });
      const ctx = detailed.text;
      log(`上下文 ${ctx.length} 字`);

      const prompt = buildPrompt(ctx, q);

      await this.openChat(win);
      if (_chat && _chat.DSHChat) {
        _chat.DSHChat.setContext(items.length, ctx.length);
        _chat.DSHChat.setMaterials(detailed.report);   // v1.4.0：材料面板
        _chat.DSHChat.appendUser(q);
        _chat.DSHChat.setBusy(true);
        try {
          const { text, code, sessionId, workspace, stderrTail } = await this.runDSH(prompt, {
            sessionId: _chat.DSHChat.sessionId,   // v1.8.0：菜单发起也走续接
            onChunk: (t) => _chat.DSHChat.setAnswer(t),
            onQueued: (q) => _chat.DSHChat.setStatus(`排队中（前面还有 ${q} 个）…`),
          });
          // v1.4.0：末尾必须传 true —— 只有收尾那次才渲染 Markdown
          // （流式期间渲染 Markdown 是 O(n²)）。
          _chat.DSHChat.setAnswer(text, true);
          // v1.8.0：修掉一处已知不一致 —— 菜单路径以前把 sessionId 丢掉了。
          // v1.9.0：登记时用**本次实际用的工作区**（workspace），不是此刻的首选项。
          if (sessionId) {
            _chat.DSHChat.sessionId = sessionId;
            _chat.DSHChat.updateSession();
            _chat.DSHChat.registerSession(sessionId, workspace);
          }
          _chat.DSHChat.setRunWorkspace(workspace);
          _chat.DSHChat.refreshCitations();
          _chat.DSHChat.saveHistory();
          if (!text && stderrTail) _chat.DSHChat.push("error", "DSH 报错（退出码 " + code + "）：\n" + stderrTail);
          else if (code !== 0 && code !== null) _chat.DSHChat.appendNote(`（dsh 退出码 ${code}）`);
        } catch (e) {
          _chat.DSHChat.appendNote("**出错**：" + (e && e.message ? e.message : e));
        } finally {
          _chat.DSHChat.setBusy(false);
        }
      }
    },

    /**
     * v1.5.0 · 阅读器入口：把一段文字（通常是划词选中的）作为提问发给 DSH。
     * 与窗口走**同一个串行闸门** —— 所以阅读器和窗口不会互相打断：
     * 谁先到谁先跑，后来的排队，UI 上会显示"排队中（前面还有 N 个）"。
     */
    async askFromReader(question, reader) {
      const q = String(question == null ? "" : question).trim();
      if (!q) { log("[reader] 空提问，忽略"); return; }

      // 找到阅读器当前对应的条目。字段名不确定，逐个试；拿不到就退回主窗口选中项。
      let items = [];
      let itemID = null;
      try {
        itemID = reader && (reader.itemID || reader._itemID || (reader._item && reader._item.id));
      } catch (e) {}
      if (itemID) { try { const it = Zotero.Items.get(itemID); if (it) items = [it]; } catch (e) {} }
      if (!items.length) { try { items = this.selectedItems(); } catch (e) {} }
      log(`[reader] askFromReader：itemID=${itemID} 材料条数=${items.length}`);

      const win = Zotero.getMainWindow();
      await this.openChat(win);
      const chat = _chat && _chat.DSHChat;
      if (!chat) { log("[reader] 对话窗口不可用，放弃"); return; }

      let ctx = "";
      try {
        const d = await this.collectContextDetailed(items, {
          fulltext: this.getPref("includeFulltext"),
        });
        ctx = d.text;
        chat.setMaterials(d.report);
      } catch (e) { log("[reader] 收集上下文失败：" + e); }

      chat.setContext(items.length, ctx.length);
      chat.appendUser(q + "　（来自阅读器）");
      chat.push("assistant", "");
      chat.setBusy(true);
      try {
        const { text, code, sessionId, workspace, stderrTail } = await this.runDSH(buildPrompt(ctx, q), {
          sessionId: chat.sessionId,     // v1.9.0：与窗口共用同一条会话线
          onChunk: (t) => chat.setAnswer(t),
          onQueued: (n) => chat.setStatus(`排队中（前面还有 ${n} 个）…`),
        });
        chat.setAnswer(text, true);
        // v1.9.0：阅读器这条入口以前漏了这三步 —— 于是"从阅读器发起的对话"
        // 既不登记进所选工作区、也不进历史、也不算引文核对。
        if (sessionId) {
          chat.sessionId = sessionId;
          chat.updateSession();
          chat.registerSession(sessionId, workspace);
        }
        chat.setRunWorkspace(workspace);
        chat.refreshCitations();
        chat.saveHistory();
        if (!text && stderrTail) chat.push("error", "DSH 报错（退出码 " + code + "）：\n" + stderrTail);
        else if (code !== 0 && code !== null) chat.appendNote(`（dsh 退出码 ${code}）`);
      } catch (e) {
        chat.setAnswer("", true);
        chat.push("error", e && e.message ? e.message : String(e));
      } finally {
        chat.setBusy(false);
      }
    },

    // ---------- 工作区（v1.6.0）----------
    listWorkspaces() { return listWorkspaces(); },
    zoteroCwd() { return zoteroCwd(); },
    getWorkspace() {
      const p = String(this.getPref("workspace") || "").trim();
      return p || zoteroCwd();
    },
    getWorkspacePref() { return String(this.getPref("workspace") || "").trim(); },
    setWorkspace(path) {
      const v = String(path == null ? "" : path).trim();
      try {
        Zotero.Prefs.set("extensions.dshbridge.workspace", v, true);
        log("[ws] 工作区已设为：" + (v || "(空 = 用 Zotero 的 cwd)"));
        return true;
      } catch (e) { log("[ws] 写首选项失败：" + e); return false; }
    },

    // ---------- 写回 Zotero（v1.6.0）----------

    /** 建一条笔记。html 已在窗口侧由 MD.toHTML() 转义产出，这里不再拼任何模型原文。 */
    async createNote(html, parentItemID) {
      let parent = null;
      if (parentItemID) {
        try { parent = Zotero.Items.get(parentItemID); } catch (e) {}
      }
      const note = new Zotero.Item("note");
      try { note.libraryID = parent ? parent.libraryID : Zotero.Libraries.userLibraryID; } catch (e) {}
      if (parent) note.parentItemID = parent.id;
      note.setNote(String(html || ""));
      await note.saveTx();
      log("[note] 已创建笔记 id=" + note.id + (parent ? " 父条目=" + parent.id : " （独立）"));
      return { id: note.id, parentID: parent ? parent.id : null };
    },

    /** 在主窗口里选中这些条目 —— 让"所列文献"在 Zotero 里以列表形式出现 */
    async revealInZotero(itemIDs) {
      const ids = (itemIDs || []).filter((x) => typeof x === "number" && x > 0);
      if (!ids.length) throw new Error("没有可定位的条目");
      const win = Zotero.getMainWindow();
      const pane = win && win.ZoteroPane;
      if (!pane) throw new Error("拿不到主窗口的 ZoteroPane");
      // 已核：selectItems(itemIDs, options) 是 async，第二参必须是对象
      await pane.selectItems(ids, {});
      try { win.focus(); } catch (e) {}
      log("[reveal] 已在主窗口选中 " + ids.length + " 条");
      return ids.length;
    },

    /** 把这些条目归到一个集合里（按名字复用已有的那个） */
    async groupAsCollection(itemIDs, name) {
      const ids = (itemIDs || []).filter((x) => typeof x === "number" && x > 0);
      if (!ids.length) throw new Error("没有可归集的条目");
      const libID = Zotero.Libraries.userLibraryID;
      const want = String(name || "DSH Bridge · 会话材料");

      let col = null;
      try {
        // 已核：Zotero.Collections.getByLibrary(libraryID, recursive, includeTrashed)
        const all = Zotero.Collections.getByLibrary(libID, true, false) || [];
        for (const c of all) { if (c.name === want) { col = c; break; } }
      } catch (e) { log("[col] 查已有集合失败：" + e); }

      if (!col) {
        col = new Zotero.Collection();
        col.libraryID = libID;
        col.name = want;
        await col.saveTx();
        log("[col] 新建集合：" + want + " id=" + col.id);
      }
      await col.addItems(ids);
      log("[col] 已把 " + ids.length + " 条加入集合 " + col.id);
      return { id: col.id, name: col.name, count: ids.length };
    },

    /**
     * v1.7.0：把会话登记进 DSH 的工作区，使它在 DSH 界面里直接可见 —— 不必再走导入。
     *
     * 已核实的机制（读 ~/.dsh/storages/workspace.json 与 ~/.dsh/sessions/）：
     *   · 会话文件按 **cwd 分桶** 存放（目录名是编码后的 cwd）
     *   · 但 DSH 界面**不扫桶**：它只列 workspace.json 里各工作区 `sessionIds` 中的会话
     *   · 实据：桶里共 93 个会话目录，登记表只认 29 个；
     *           插件那次会话 `session-120a8d4a-…` 在正确的桶里，却不在任何 sessionIds
     *           —— 所以界面里看不见，用户不得不手动导入（导入产物是 import-session-120a8d4a-…）
     *
     * 这里的做法与"导入"不同：**直接登记原会话号，不复制**。
     *
     * ⚠️ 这是在写 DSH 自己的状态文件，属于侵入性操作，所以护栏齐全：
     *   · 只往**路径与本次工作区一致**的那个工作区里加，找不到就不动
     *   · 写前先备份；读—改—写之间尽量短；用临时文件 + 置换，避免写坏
     *   · **只增不删**，不改结构，不动其它字段
     * 护栏见下；另外**置换失败时会用备份还原**（见函数体内的注释）。
     *
     * @param {string} sessionId
     * @param {string} [workspaceOverride] v1.9.0：**本次运行实际用的工作区**。
     *   必须由调用方从 runDSH 的结果里带过来 —— 会话落在哪个桶由 spawn 时的 workdir 决定，
     *   在这里临时再读一次首选项，就可能「登记到 A、文件却在 B」。
     *   传 `undefined` 才回退到读首选项；传空串表示"本次确实没指定工作区"。
     * @param {Object} [opts] v1.9.2：`{ force: true }` = 连归档状态一起恢复（仅限用户显式动作）。
     */
    async registerSessionInWorkspace(sessionId, workspaceOverride, opts) {
      const sid = String(sessionId || "").trim();
      if (!sid) return { ok: false, why: "没有会话号" };
      if (Zotero.Prefs.get("extensions.dshbridge.registerSessions", true) === false) {
        return { ok: false, why: "首选项 registerSessions=false" };
      }
      const wsPath = (workspaceOverride === undefined)
        ? String(this.getPref("workspace") || "").trim()
        : String(workspaceOverride == null ? "" : workspaceOverride).trim();
      if (!wsPath) {
        return { ok: false, why: "本次没有指定工作区 —— 会话落在 Zotero 自己的目录，无处可登记" };
      }

      const regPath = (function () {
        try {
          const p = Zotero.Prefs.get("extensions.dshbridge.workspaceRegistry", true);
          if (typeof p === "string" && p.trim()) return p.trim();
        } catch (e) {}
        return workspaceRegistryPath();   // 同一个默认值来源
      })();
      if (!regPath) return { ok: false, why: "拿不到登记表路径" };

      let text;
      try {
        text = readTextFile(regPath);
      } catch (e) { return { ok: false, why: "读登记表失败：" + e }; }
      if (text == null) return { ok: false, why: "登记表不存在" };

      let j;
      try { j = JSON.parse(text); }
      catch (e) { log("[reg] 登记表不是合法 JSON，放弃（绝不猜着写）：" + e); return { ok: false, why: "登记表不是合法 JSON" }; }

      const wss = j && j.tables && j.tables.workspaces;
      if (!wss || typeof wss !== "object") return { ok: false, why: "登记表结构不符（没有 tables.workspaces）" };

      // 找 path 与本次工作区一致的那一项
      let targetKey = null, target = null;
      for (const k of Object.keys(wss)) {
        const w = wss[k];
        if (w && String(w.path || "").toLowerCase() === wsPath.toLowerCase()) { targetKey = k; target = w; break; }
      }
      if (!target) {
        return {
          ok: false,
          why: `「${wsPath}」还没在 DSH 里登记为工作区 —— 先在 DSH 界面把该目录打开一次，它就会登记上；`
             + `之后再从这里对话就会自动归位。`,
        };
      }
      if (!Array.isArray(target.sessionIds)) target.sessionIds = [];
      if (target.sessionIds.includes(sid)) return { ok: true, why: "已在登记表中", already: true };

      // v1.9.2：先看它是不是**被归档**了 —— 实机数据表明这是真实会发生的情况：
      // 登记的会话确实写进去了（备份与计数双重佐证），但随后有两条进了
      // global.archivedSessionIds（从 sessionIds 移出）。**那是归档，不是覆盖。**
      // 默认**尊重归档**（那是用户的决定）；只有用户在界面上显式点「重新登记」才取回。
      const arch = (j.global && Array.isArray(j.global.archivedSessionIds))
        ? j.global.archivedSessionIds : null;
      const isArchived = !!(arch && arch.includes(sid));
      if (isArchived && !(opts && opts.force)) {
        return {
          ok: false, archived: true,
          why: "这个会话已被归档（在 DSH 的归档列表里）—— 点历史栏的「重新登记」可把它取回工作区列表",
        };
      }
      if (isArchived && opts && opts.force) {
        // 只移除**这一个** id，别的归档项一动不动
        j.global.archivedSessionIds = arch.filter((x) => x !== sid);
        log("[reg] 已把会话从归档列表中取回：" + sid);
      }

      target.sessionIds.push(sid);          // 只 push，不重排、不删
      try { target.updatedAt = new Date().toISOString(); } catch (e) {}

      // 备份 + 原子置换
      const bak = regPath + ".dsh-bridge-backup-" + Date.now();
      try {
        writeTextFile(bak, text);                              // 原文备份
        const tmp = regPath + ".dsh-bridge-tmp";
        writeTextFile(tmp, JSON.stringify(j, null, 2));        // 新内容写临时文件

        const Ftmp = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
        Ftmp.initWithPath(tmp);
        const dst = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
        dst.initWithPath(regPath);

        let moved = false;
        try {
          if (dst.exists()) dst.remove(false);
          Ftmp.moveTo(dst.parent, dst.leafName);
          moved = true;
        } catch (e) {
          // v1.9.1：置换失败**必须立刻还原**。
          // 旧写法是「删原件 → 改名」，moveTo 一旦失败（文件被占用、杀软、权限），
          // DSH 的 workspace.json 就没了、只剩一个备份文件躺在旁边。
          log("[reg] 置换失败，正在用备份还原：" + e);
          try {
            if (!dst.exists()) {
              const B = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
              B.initWithPath(bak);
              B.copyTo(dst.parent, dst.leafName);
              log("[reg] 已用备份还原 " + regPath);
            } else {
              log("[reg] 目标文件仍在，未动它");
            }
          } catch (e2) { log("[reg] **还原也失败了**，请手工把 " + bak + " 复制回 " + regPath + "：" + e2); }
        }

        if (!moved) {
          return { ok: false, why: "写登记表失败（已尝试还原，见日志）" };
        }
        log(`[reg] 已把会话 ${sid} 登记进工作区「${target.title || targetKey}」（${target.sessionIds.length} 条）`);
        return { ok: true, count: target.sessionIds.length, title: target.title || targetKey };
      } catch (e) {
        log("[reg] 写登记表失败：" + e);
        return { ok: false, why: "写失败：" + e };
      }
    },

    /** v1.7.0：改已有笔记的正文（用于"AI 起标题"回填首行） */
    async updateNote(noteID, html) {
      const note = Zotero.Items.get(noteID);
      if (!note) throw new Error("找不到笔记 " + noteID);
      if (typeof note.isNote === "function" && !note.isNote()) throw new Error(noteID + " 不是笔记");
      note.setNote(String(html || ""));
      await note.saveTx();
      log("[note] 已更新笔记 id=" + noteID);
      return noteID;
    },

    /**
     * v1.8.0：设置面板的「测试连接」。
     * 检查三件事：两个路径存不存在、`node <bin> --profile X --dump-config` 能不能跑通。
     * 特意用 --dump-config：它**不调模型**，几秒内返回，够证明 node/bin/profile 这条链是活的；
     * 真正的模型连通性只能靠发一次问答（那要几十秒，不适合放按钮里）。
     */
    async testConnection() {
      const node = this.getPref("nodePath");
      const bin = this.getPref("dshBin");
      const profile = this.getPref("profile");
      const lines = [];
      const exists = (p) => {
        try {
          const f = Components.classes["@mozilla.org/file/local;1"]
            .createInstance(Components.interfaces.nsIFile);
          f.initWithPath(String(p || ""));
          return f.exists();
        } catch (e) { return false; }
      };
      const ws = String(this.getPref("workspace") || "").trim();
      lines.push((exists(node) ? "✅" : "❌") + " node：" + node);
      lines.push((exists(bin) ? "✅" : "❌") + " dsh　：" + bin);
      lines.push("　 工作区：" + (ws || (zoteroCwd() + "　（未指定，用 Zotero 的目录）")));
      if (ws && !exists(ws)) lines.push("❌ 工作区目录不存在：" + ws);

      if (!exists(node) || !exists(bin)) {
        lines.push("");
        lines.push("路径不对，先修上面两项。");
        return lines.join("\n");
      }

      try {
        let Subprocess;
        ({ Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs"));
        const opts = { command: node, arguments: [bin, "--profile", profile, "--dump-config"], stderr: "pipe" };
        if (ws) opts.workdir = ws;
        const proc = await Subprocess.call(opts);
        let out = "";
        const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} }, 15000);
        try {
          while (true) {
            const s = await proc.stdout.readString();
            if (!s) break;
            out += s;
            if (out.length > 4000) break;     // 够了就收工
          }
        } finally {
          clearTimeout(timer);
          // 提前 break 时进程可能还在跑 —— 收掉它，别留孤儿
          try { proc.kill(); } catch (e) {}
        }
        const head = out.split("\n").slice(0, 6).join("\n").trim();
        lines.push("");
        lines.push("✅ 配置可加载（node + bin + profile 都通）");
        if (head) lines.push("--- 输出开头 ---\n" + head);
      } catch (e) {
        lines.push("");
        lines.push("❌ 跑不起来：" + (e && e.message ? e.message : e));
      }
      return lines.join("\n");
    },

    // ---------- 会话历史（v1.8.0）----------
    // 存在插件自己的文件里，不进 Zotero 库。
    // 存的是**我们本来就持有的对话文本**（messages），所以恢复时能直接铺回消息区；
    // DSH 那边的 session 文件是 zstd 压缩的、插件解不开，只能靠这份。

    historyPath() {
      let p = "";
      try { p = String(Zotero.Prefs.get("extensions.dshbridge.historyPath", true) || "").trim(); } catch (e) {}
      if (p) return p;
      // 默认：与日志同目录
      const lp = logPath();
      if (lp) {
        const i = Math.max(lp.lastIndexOf("\\"), lp.lastIndexOf("/"));
        if (i > 0) return lp.slice(0, i + 1) + "dsh-bridge-history.json";
      }
      return "";
    },

    loadHistory() {
      try {
        const p = this.historyPath();
        if (!p) return { version: 1, sessions: [] };
        const t = readTextFile(p);
        if (t == null) return { version: 1, sessions: [] };
        const j = JSON.parse(t);
        if (j && Array.isArray(j.sessions)) return j;
      } catch (e) { log("[hist] 读历史失败：" + e); }
      return { version: 1, sessions: [] };
    },

    saveHistory(h) {
      try {
        const p = this.historyPath();
        if (!p) return false;
        // 上限：最近 60 个会话；每个会话最多留 40 条消息，单条截到 8000 字
        const sessions = (h && Array.isArray(h.sessions) ? h.sessions : []).slice(0, 60).map((s) => ({
          sid: s.sid || null,
          title: String(s.title || "").slice(0, 120),
          createdAt: s.createdAt || Date.now(),
          updatedAt: s.updatedAt || Date.now(),
          workspace: String(s.workspace || ""),
          messages: (Array.isArray(s.messages) ? s.messages : []).slice(-40).map((m) => ({
            role: m.role, text: String(m.text || "").slice(0, 8000),
          })),
        }));
        writeTextFile(p, JSON.stringify({ version: 1, sessions }, null, 1));
        return true;
      } catch (e) { log("[hist] 写历史失败：" + e); return false; }
    },

    async openChat(win) {
      if (_chat && !_chat.closed) { _chat.focus(); return _chat; }
      if (!win || win.closed) win = Zotero.getMainWindow();
      const url = this.chatURL();
      log("openDialog: " + url);

      // v1.3.1：chat.xhtml 里的 <script src> / <stylesheet href> 走的是
      // chrome://dshbridge/ 绝对路径，所以 registerChrome 一旦失败，
      // chatURL() 里"退回 rootURI"这条回退路其实是死路——窗口会打开但一片空白。
      // 这里把原因显式说出来，不再让用户对着空窗口猜。
      if (!this.chromeRegistered) {
        log("**chrome 未注册**：回退路径下窗口资源极可能加载不出来（空白窗口）");
        try {
          Services.prompt.alert(win, "DSH Bridge",
            "插件的 chrome 注册失败了。\n\n"
            + "对话窗口的脚本与样式表走 chrome://dshbridge/ 绝对路径，"
            + "注册失败时窗口会打开、但内容一片空白。\n\n"
            + "请到日志里查 registerChrome 那一行：\n" + logPath());
        } catch (e) {}
      }
      try {
        // 参考 AI Paper Chat：用 dialog=no 的普通窗口，而不是模态对话框。
        // 第 4 个参数必须传 —— 窗口靠它拿 DSHBridge。
        // （v1.2.0 曾漏掉这个参数，导致窗口内 bridge=null。）
        _chat = win.openDialog(
          url, "dshbridge-chat",
          "chrome,dialog=no,resizable=yes,centerscreen,width=920,height=740,minimizable=yes",
          { DSHBridge: this }
        );
        log("窗口已打开" + (_chat ? "" : "（openDialog 返回空）"));
      } catch (e) {
        log("**打开窗口失败**：" + e);
        Services.prompt.alert(win, "DSH Bridge", "打开对话窗口失败：\n" + e);
        _chat = null;
      }
      return _chat;
    },
  };
}
