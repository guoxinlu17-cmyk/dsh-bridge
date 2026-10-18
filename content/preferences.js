// DSH Bridge 设置面板的脚本（v1.8.0 新增）
//
// 由 Zotero.PreferencePanes.register({ pluginID, src, id, scripts }) 里的 scripts 加载，
// 运行在**设置窗口**的作用域里（不是插件自身的 bootstrap 作用域）。
// 因此这里不直接碰 _running / _proc 等私有状态，只调 Zotero.DSHBridge 暴露出来的方法。
//
// 首选项的读写**不在这里做** —— 面板上的 preference="..." 由 Zotero 的偏好系统自动绑定。

var DSHBridgePrefs = {
  init() {
    try { this.fillWorkspaces(); }
    catch (e) { /* 面板不该因为这里出错而打不开 */ }
  },

  /** 把已登记的工作区列出来（只读展示，供复制粘贴用） */
  fillWorkspaces() {
    const el = document.getElementById("dshbridge-ws-info");
    if (!el) return;
    let b = null;
    try { b = (typeof Zotero !== "undefined" && Zotero) ? Zotero.DSHBridge : null; } catch (e) {}
    if (!b) { el.textContent = "（插件尚未就绪 —— 重开一次设置窗口即可）"; return; }
    let list = [];
    try { list = (b.listWorkspaces && b.listWorkspaces()) || []; } catch (e) {}
    if (!list.length) {
      el.textContent = "（没读到工作区登记表；上面的「工作区登记表」留空时会去 ~/.dsh/storages/workspace.json 找）";
      return;
    }
    el.textContent = "已登记 " + list.length + " 个工作区（可直接复制到上面）：\n"
      + list.map((w) => "　" + w.title + "　" + w.path).join("\n");
  },

  /** 测试连接 —— 调 bootstrap 侧的 testConnection() */
  async test() {
    const out = document.getElementById("dshbridge-test-result");
    const say = (s) => { if (out) out.textContent = s; };
    say("测试中…");
    let b = null;
    try { b = Zotero.DSHBridge; } catch (e) {}
    if (!b || !b.testConnection) { say("❌ 拿不到 DSHBridge（插件没就绪？）"); return; }
    try {
      say(await b.testConnection());
    } catch (e) {
      say("❌ 测试时出错：" + (e && e.message ? e.message : e));
    }
  },
};
