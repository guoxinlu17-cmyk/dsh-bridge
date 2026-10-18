// DSH Bridge —— 引文抽取与核对（v1.7.0 新增）
//
// 干什么：把 DSH 回答里的「引文」抽出来，再回溯到**本次真正发给模型的材料正文**，
//        告诉用户这句到底是原文，还是模型自己的话。
//
// 为什么单独成文件：
//   这里的判断（是不是原文）是这套 UI 里最该被守住的一环 ——
//   它一旦偏了，用户会以为模型没编，实际编了。所以四个函数全部写成**纯函数**，
//   不依赖 document / Zotero，可以在 node 里直接单测（见 tests/md-tokenizer.test.mjs）。

const CITE = (() => {
  /** 规范化：去掉空白与中英标点，便于比对 */
  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/[\s\u3000，。、；：！？,.;:!?"'“”「」『』（）()《》〈〉\[\]【】\-—–…·]/g, "")
      .toLowerCase();
  }

  /**
   * 从回答里抽引文候选。
   * 两条来源：① 引号内的整句（「」『』“” "）；② Markdown 引用块（> 开头）。
   * 少于 8 个字的丢掉 —— 那多半是词，不是引文，抽出来只会制造噪音。
   */
  function extractQuotes(text) {
    const t = String(text == null ? "" : text);
    const out = [];
    const push = (s, how) => {
      const v = String(s || "").replace(/\s+/g, " ").trim();
      if (v.length >= 8) out.push({ text: v, how });
    };
    const re = /[「『“"]([^」』”"]{8,300})[」』”"]/g;
    let m;
    while ((m = re.exec(t))) push(m[1], "引号");
    for (const line of t.split("\n")) {
      const q = /^\s*>\s?(.+)$/.exec(line);
      if (q) push(q[1], "引用块");
    }
    const seen = new Set();
    return out.filter((x) => {
      const k = norm(x.text);
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
  }

  /**
   * 窗口命中率：把引文切成若干 16 字窗口，看在材料里能命中几成。
   * 不用最长公共子串 —— 在 6 万字材料上做 O(n·m) 太慢；
   * 多窗口 indexOf 是原生实现，够判断"这是不是那段原文"。
   */
  function windowHit(needleNorm, hayNorm) {
    if (!needleNorm) return 0;
    const W = 16, STEP = 8;
    if (needleNorm.length <= W) return hayNorm.indexOf(needleNorm) >= 0 ? 1 : 0;
    let total = 0, hit = 0;
    for (let i = 0; i + W <= needleNorm.length; i += STEP) {
      total++;
      if (hayNorm.indexOf(needleNorm.slice(i, i + W)) >= 0) hit++;
    }
    total++;
    if (hayNorm.indexOf(needleNorm.slice(needleNorm.length - W)) >= 0) hit++;
    return total ? hit / total : 0;
  }

  /**
   * 把引文回溯到材料。
   * @param {Array} quotes extractQuotes 的结果
   * @param {Array} mats   [{ itemID, title, text }] —— **只传本次真正发出去的正文**；
   *                       拿别的东西比对，会把"材料里没有"误报成"有"。
   * @param {number} threshold 近似匹配的下限（默认 0.5）
   */
  function matchQuotes(quotes, mats, threshold) {
    const th = (typeof threshold === "number") ? threshold : 0.5;
    const pool = (mats || []).filter((m) => m && typeof m.text === "string" && m.text);
    const norms = pool.map((m) => norm(m.text));   // 规范化只做一次
    return (quotes || []).map((q) => {
      const nq = norm(q.text);
      let best = null;
      for (let i = 0; i < pool.length; i++) {
        if (norms[i].indexOf(nq) >= 0) {
          best = { itemID: pool[i].itemID, title: pool[i].title, kind: "exact", ratio: 1 };
          break;
        }
      }
      if (!best) {
        let bestR = 0, bestI = -1;
        for (let i = 0; i < pool.length; i++) {
          const r = windowHit(nq, norms[i]);
          if (r > bestR) { bestR = r; bestI = i; }
        }
        if (bestI >= 0 && bestR >= th) {
          best = { itemID: pool[bestI].itemID, title: pool[bestI].title, kind: "partial", ratio: bestR };
        }
      }
      return { quote: q.text, how: q.how, match: best };
    });
  }

  return { norm, extractQuotes, windowHit, matchQuotes };
})();

// node 下可 require（用于单测）；浏览器里无副作用。
if (typeof module !== "undefined" && module.exports) module.exports = CITE;
