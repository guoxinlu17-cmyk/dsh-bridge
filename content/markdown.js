// DSH Bridge —— 极简 Markdown 渲染器（v1.4.0 新增）
//
// 三条不可违反的设计约束：
//   1. 【安全】全文件不出现 innerHTML / outerHTML / insertAdjacentHTML。
//      回答内容来自模型，属不可信文本；节点一律用 createElementNS 构造。
//      这与 chat.js 里 el() 的既有约定（"一律 textContent，绝不 innerHTML"）同源。
//   2. 【可测】tokenize() 与 inline() 是纯函数，不依赖 document —— 可在 node 里单测。
//      文件末尾有 CommonJS 导出（浏览器里它就是个普通脚本，不受影响）。
//   3. 【克制】只支持对话里真会出现的子集，不追求完整 CommonMark。

const MD = (() => {
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  // 只允许这三种协议 —— 挡住 javascript: / data: 之类的链接
  const SAFE_SCHEME = /^(https?:|mailto:)/i;

  // ============================================================
  //  词法分析（纯函数）
  // ============================================================

  const isBlank = (l) => !l || !l.trim();
  const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^\s{0,3}([-*_])\s*(\1\s*){2,}$/;
  const QUOTE = /^\s{0,3}>\s?(.*)$/;
  const UL = /^(\s*)[-*+]\s+(.*)$/;
  const OL = /^(\s*)\d+[.)]\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  /** 把源码切成块级 token。返回纯数据，便于断点测试。 */
  function tokenize(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isBlank(line)) { i++; continue; }

      // 围栏代码块
      const fence = FENCE.exec(line);
      if (fence) {
        const close = fence[1];
        const lang = fence[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !new RegExp("^\\s*" + close + "\\s*$").test(lines[i])) {
          body.push(lines[i]); i++;
        }
        i++; // 吃掉收尾围栏（没有收尾时越界即停，属容错）
        out.push({ type: "code", lang, text: body.join("\n") });
        continue;
      }

      // 标题
      const h = HEADING.exec(line);
      if (h) { out.push({ type: "heading", level: h[1].length, text: h[2] }); i++; continue; }

      // 水平线
      if (HR.test(line)) { out.push({ type: "hr" }); i++; continue; }

      // 表格：本行含 | 且下一行是分隔行
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const header = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
          rows.push(splitRow(lines[i])); i++;
        }
        out.push({ type: "table", header, rows });
        continue;
      }

      // 引用块
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (!isBlank(lines[i]) && body.length && !UL.test(lines[i]) && !OL.test(lines[i])))) {
          const m = QUOTE.exec(lines[i]);
          body.push(m ? m[1] : lines[i].trim());
          i++;
        }
        out.push({ type: "quote", text: body.join("\n") });
        continue;
      }

      // 列表（同一层级的连续项；不做嵌套，保持克制）
      const ul = UL.exec(line), ol = OL.exec(line);
      if (ul || ol) {
        const ordered = !!ol;
        const items = [];
        while (i < lines.length) {
          const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
          if (!m) break;
          items.push(m[2]); i++;
        }
        out.push({ type: "list", ordered, items });
        continue;
      }

      // 段落：连续非空、且不是其它块起始的行
      const para = [];
      while (i < lines.length && !isBlank(lines[i]) &&
             !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])) {
        para.push(lines[i].trim()); i++;
      }
      if (para.length) out.push({ type: "p", text: para.join(" ") });
      else i++; // 兜底防死循环
    }
    return out;
  }

  /**
   * 行内解析。返回 run 数组：
   *   {t:'text',v} {t:'code',v} {t:'strong',v} {t:'em',v} {t:'link',v,href}
   * v 对 strong/em 是**尚未解析的内层原文**，由调用方递归处理（只递归一层）。
   */
  function inline(text) {
    const s = String(text == null ? "" : text);
    const runs = [];
    let buf = "";
    let i = 0;

    const flush = () => { if (buf) { runs.push({ t: "text", v: buf }); buf = ""; } };

    while (i < s.length) {
      const ch = s[i];

      // 行内代码 `...`（优先级最高，内部不再解析）
      if (ch === "`") {
        const end = s.indexOf("`", i + 1);
        if (end > i + 1) { flush(); runs.push({ t: "code", v: s.slice(i + 1, end) }); i = end + 1; continue; }
      }

      // 粗体 **...**
      if (ch === "*" && s[i + 1] === "*") {
        const end = s.indexOf("**", i + 2);
        if (end > i + 2) { flush(); runs.push({ t: "strong", v: s.slice(i + 2, end) }); i = end + 2; continue; }
      }

      // 斜体 *...* （避开 ** 的情形）
      if (ch === "*" && s[i + 1] !== "*") {
        const end = s.indexOf("*", i + 1);
        if (end > i + 1) { flush(); runs.push({ t: "em", v: s.slice(i + 1, end) }); i = end + 1; continue; }
      }

      // 链接 [text](href)
      if (ch === "[") {
        const close = s.indexOf("]", i + 1);
        if (close > i + 1 && s[close + 1] === "(") {
          const paren = s.indexOf(")", close + 2);
          if (paren > close + 2) {
            const href = s.slice(close + 2, paren).trim();
            flush();
            runs.push({ t: "link", v: s.slice(i + 1, close), href });
            i = paren + 1; continue;
          }
        }
      }

      buf += ch; i++;
    }
    flush();
    return runs;
  }

  // ============================================================
  //  渲染（依赖 document，仅窗口内使用）
  // ============================================================

  function el(doc, tag, cls) {
    const e = doc.createElementNS(XHTML_NS, tag);
    if (cls) e.setAttribute("class", cls);
    return e;
  }

  function renderInline(doc, text, depth) {
    const frag = doc.createDocumentFragment();
    for (const r of inline(text)) {
      if (r.t === "text") { frag.appendChild(doc.createTextNode(r.v)); continue; }
      if (r.t === "code") { const e = el(doc, "code", "md-code"); e.textContent = r.v; frag.appendChild(e); continue; }
      if (r.t === "strong" || r.t === "em") {
        const e = el(doc, r.t === "strong" ? "strong" : "em");
        // 只递归一层，避免畸形输入造成深递归
        if (depth > 0) e.appendChild(renderInline(doc, r.v, depth - 1));
        else e.textContent = r.v;
        frag.appendChild(e); continue;
      }
      if (r.t === "link") {
        const ok = SAFE_SCHEME.test(r.href);
        const e = el(doc, ok ? "a" : "span", ok ? "md-link" : "md-link md-link-blocked");
        e.textContent = r.v;
        if (ok) {
          e.setAttribute("href", r.href);
          // 交给 Zotero 打开，不在窗口内导航
          e.addEventListener("click", (ev) => {
            ev.preventDefault();
            try { Zotero.launchURL(r.href); } catch (err) {}
          });
        } else {
          e.setAttribute("title", "已拦截非常规链接：" + r.href);
        }
        frag.appendChild(e); continue;
      }
    }
    return frag;
  }

  /** 把 Markdown 渲染成节点数组（不返回字符串，不碰 innerHTML）。 */
  function render(doc, src) {
    const nodes = [];
    for (const b of tokenize(src)) {
      if (b.type === "heading") {
        const lv = Math.min(6, Math.max(1, b.level));
        const e = el(doc, "h" + lv, "md-h md-h" + lv);
        e.appendChild(renderInline(doc, b.text, 1));
        nodes.push(e);
      } else if (b.type === "hr") {
        nodes.push(el(doc, "hr", "md-hr"));
      } else if (b.type === "code") {
        const pre = el(doc, "pre", "md-pre");
        const code = el(doc, "code");
        code.textContent = b.text;          // ← textContent，不是 innerHTML
        if (b.lang) pre.setAttribute("data-lang", b.lang);
        pre.appendChild(code);
        nodes.push(pre);
      } else if (b.type === "quote") {
        const q = el(doc, "blockquote", "md-quote");
        for (const line of b.text.split("\n")) {
          const p = el(doc, "p");
          p.appendChild(renderInline(doc, line, 1));
          q.appendChild(p);
        }
        nodes.push(q);
      } else if (b.type === "list") {
        const l = el(doc, b.ordered ? "ol" : "ul", "md-list");
        for (const it of b.items) {
          const li = el(doc, "li");
          li.appendChild(renderInline(doc, it, 1));
          l.appendChild(li);
        }
        nodes.push(l);
      } else if (b.type === "table") {
        const t = el(doc, "table", "md-table");
        const thead = el(doc, "thead");
        const hr = el(doc, "tr");
        for (const c of b.header) { const th = el(doc, "th"); th.appendChild(renderInline(doc, c, 1)); hr.appendChild(th); }
        thead.appendChild(hr); t.appendChild(thead);
        const tb = el(doc, "tbody");
        for (const row of b.rows) {
          const tr = el(doc, "tr");
          for (let k = 0; k < b.header.length; k++) {
            const td = el(doc, "td");
            td.appendChild(renderInline(doc, row[k] == null ? "" : row[k], 1));
            tr.appendChild(td);
          }
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        nodes.push(t);
      } else {
        const p = el(doc, "p", "md-p");
        // 段落内的单换行保留为软换行
        const parts = String(b.text).split("\n");
        parts.forEach((part, idx) => {
          if (idx) p.appendChild(el(doc, "br"));
          p.appendChild(renderInline(doc, part, 1));
        });
        nodes.push(p);
      }
    }
    return nodes;
  }

  // ============================================================
  //  HTML 序列化（v1.6.0 新增，供"存为 Zotero 笔记"用）
  // ============================================================
  // Zotero 笔记正文是 HTML 字符串，所以这里必须产出字符串 —— 但**绝不拼未转义的模型输出**。
  // 做法：走同一棵 token 树，标签全部由我们自己发，文本一律先 esc()。
  // 也就是说：安全性与 DOM 渲染那条路同级 —— 不是"记得转义"，而是"没有别的出路"。

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineHTML(text, depth) {
    let out = "";
    for (const r of inline(text)) {
      if (r.t === "text") { out += esc(r.v); continue; }
      if (r.t === "code") { out += "<code>" + esc(r.v) + "</code>"; continue; }
      if (r.t === "strong" || r.t === "em") {
        const tag = r.t === "strong" ? "strong" : "em";
        out += depth > 0
          ? "<" + tag + ">" + inlineHTML(r.v, depth - 1) + "</" + tag + ">"
          : "<" + tag + ">" + esc(r.v) + "</" + tag + ">";
        continue;
      }
      if (r.t === "link") {
        // 与 DOM 渲染同一条白名单：非常规协议只留文字，不给 href
        out += SAFE_SCHEME.test(r.href)
          ? '<a href="' + esc(r.href) + '">' + esc(r.v) + "</a>"
          : esc(r.v);
        continue;
      }
    }
    return out;
  }

  /** 把 Markdown 转成 HTML 字符串（已转义，可直接喂给 Zotero 的 note.setNote） */
  function toHTML(src) {
    let out = "";
    for (const b of tokenize(src)) {
      if (b.type === "heading") {
        const lv = Math.min(6, Math.max(1, b.level));
        out += "<h" + lv + ">" + inlineHTML(b.text, 1) + "</h" + lv + ">";
      } else if (b.type === "hr") {
        out += "<hr/>";
      } else if (b.type === "code") {
        out += "<pre><code>" + esc(b.text) + "</code></pre>";
      } else if (b.type === "quote") {
        out += "<blockquote>";
        for (const line of b.text.split("\n")) out += "<p>" + inlineHTML(line, 1) + "</p>";
        out += "</blockquote>";
      } else if (b.type === "list") {
        const tag = b.ordered ? "ol" : "ul";
        out += "<" + tag + ">";
        for (const it of b.items) out += "<li>" + inlineHTML(it, 1) + "</li>";
        out += "</" + tag + ">";
      } else if (b.type === "table") {
        out += "<table><thead><tr>";
        for (const c of b.header) out += "<th>" + inlineHTML(c, 1) + "</th>";
        out += "</tr></thead><tbody>";
        for (const row of b.rows) {
          out += "<tr>";
          for (let k = 0; k < b.header.length; k++) {
            out += "<td>" + inlineHTML(row[k] == null ? "" : row[k], 1) + "</td>";
          }
          out += "</tr>";
        }
        out += "</tbody></table>";
      } else {
        const parts = String(b.text).split("\n");
        out += "<p>";
        parts.forEach((part, idx) => {
          if (idx) out += "<br/>";
          out += inlineHTML(part, 1);
        });
        out += "</p>";
      }
    }
    return out;
  }

  return { tokenize, inline, render, toHTML, esc, XHTML_NS };
})();

// node 下可 require（用于 scripts/md-tokenizer.test.mjs）；浏览器里无副作用。
if (typeof module !== "undefined" && module.exports) module.exports = MD;
