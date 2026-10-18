// DSH Bridge —— markdown.js 词法器单测（本项目第一个自动化测试）
//
// 为什么只测词法器：tokenize() 与 inline() 是**纯函数**，不依赖 document / Zotero，
// 可以在本机 node 里直接跑。渲染层（render）依赖真实 DOM，只能在 Zotero 里人工验。
//
// 跑法：  node "D:\zotero-plugins\dsh-bridge\tests\md-tokenizer.test.mjs"
// 退出码：0 全过 / 1 有失败

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MD = require(path.join(here, "..", "content", "markdown.js"));
const CITE = require(path.join(here, "..", "content", "cite.js"));

let pass = 0;
const failures = [];

function t(name, fn) {
  try { fn(); pass++; console.log("  \u2713 " + name); }
  catch (e) { failures.push({ name, msg: e.message }); console.log("  \u2717 " + name + "\n      " + e.message); }
}

console.log("markdown.js 词法器单测\n");

// ---------- 块级 ----------
t("标题：层级与文本", () => {
  const b = MD.tokenize("# 一级\n### 三级");
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { type: "heading", level: 1, text: "一级" });
  assert.deepEqual(b[1], { type: "heading", level: 3, text: "三级" });
});

t("围栏代码块：内部的 # 不被当成标题（关键回归）", () => {
  const b = MD.tokenize("```js\n# 这不是标题\nconst a = 1;\n```");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "code");
  assert.equal(b[0].lang, "js");
  assert.equal(b[0].text, "# 这不是标题\nconst a = 1;");
});

t("围栏未闭合：容错到文末，不抛异常", () => {
  const b = MD.tokenize("```\n没了");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "code");
  assert.equal(b[0].text, "没了");
});

t("水平线：--- / *** / ___", () => {
  assert.equal(MD.tokenize("---")[0].type, "hr");
  assert.equal(MD.tokenize("***")[0].type, "hr");
  assert.equal(MD.tokenize("___")[0].type, "hr");
});

t("表格：表头 + 分隔行 + 数据行", () => {
  const b = MD.tokenize("| 项 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "table");
  assert.deepEqual(b[0].header, ["项", "值"]);
  assert.deepEqual(b[0].rows, [["a", "1"], ["b", "2"]]);
});

t("表格：分隔行不足三个连字符则不算表格（退化为段落）", () => {
  const b = MD.tokenize("| a | b |\n| - | - |");
  assert.equal(b[0].type, "p");
});

t("列表：无序与有序分开识别", () => {
  const u = MD.tokenize("- 甲\n- 乙\n* 丙");
  assert.equal(u.length, 1);
  assert.equal(u[0].ordered, false);
  assert.deepEqual(u[0].items, ["甲", "乙", "丙"]);

  const o = MD.tokenize("1. 一\n2. 二");
  assert.equal(o[0].ordered, true);
  assert.deepEqual(o[0].items, ["一", "二"]);
});

t("引用块：多行合并，> 前缀剥掉", () => {
  const b = MD.tokenize("> 第一行\n> 第二行");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "quote");
  assert.equal(b[0].text, "第一行\n第二行");
});

t("段落：连续行合并为一段", () => {
  const b = MD.tokenize("第一行\n第二行\n\n新段落");
  assert.equal(b.length, 2);
  assert.equal(b[0].type, "p");
  assert.equal(b[1].type, "p");
});

t("CRLF 与空输入不崩", () => {
  assert.equal(MD.tokenize("").length, 0);
  assert.equal(MD.tokenize(null).length, 0);
  assert.equal(MD.tokenize("a\r\nb").length, 1);
});

t("不产生死循环：以块起始符开头的孤立行全部有归属", () => {
  const b = MD.tokenize("####\n>\n-\n|");
  assert.ok(Array.isArray(b));
  assert.ok(b.length > 0);
});

// ---------- 行内 ----------
t("行内：粗体 / 行内代码", () => {
  const r = MD.inline("这是 **粗** 与 `code`");
  assert.deepEqual(r, [
    { t: "text", v: "这是 " },
    { t: "strong", v: "粗" },
    { t: "text", v: " 与 " },
    { t: "code", v: "code" },
  ]);
});

t("行内：斜体，且 ** 不被误判为两个 *", () => {
  assert.deepEqual(MD.inline("*斜*"), [{ t: "em", v: "斜" }]);
  assert.deepEqual(MD.inline("**粗**"), [{ t: "strong", v: "粗" }]);
});

t("行内：链接取出 href", () => {
  assert.deepEqual(MD.inline("[名](https://a/b)"), [{ t: "link", v: "名", href: "https://a/b" }]);
});

t("行内：未闭合标记原样保留为文本（不吞字符）", () => {
  const r = MD.inline("未闭合 **粗体");
  assert.equal(r.map((x) => x.v).join(""), "未闭合 **粗体");
});

t("行内：代码内的星号不被解析", () => {
  const r = MD.inline("`a*b*c`");
  assert.deepEqual(r, [{ t: "code", v: "a*b*c" }]);
});

// ---------- HTML 序列化（存为 Zotero 笔记用）----------
t("toHTML：模型输出里的 HTML 标签被转义，不会变成真标签", () => {
  const h = MD.toHTML("看这个 <script>alert(1)</script> 与 <img src=x onerror=y>");
  assert.ok(!h.includes("<script"), "不该出现未转义的 <script");
  assert.ok(!h.includes("<img"), "不该出现未转义的 <img");
  assert.ok(h.includes("&lt;script&gt;"), "应被转义为实体");
});

t("toHTML：属性里的引号被转义", () => {
  const h = MD.toHTML('[a](https://x/?q=")');
  assert.ok(!/href="[^"]*"[^>]*"/.test(h.replace(/&quot;/g, "@")), "href 内不应出现裸引号");
  assert.ok(h.includes("&quot;"), "引号应被转义");
});

t("toHTML：非常规协议不给 href（与 DOM 渲染同一白名单）", () => {
  const h = MD.toHTML("[点我](javascript:alert(1))");
  assert.ok(!h.includes("href"), "javascript: 不该产出 href");
  assert.ok(h.includes("点我"), "文字应保留");
});

t("toHTML：块级结构齐备", () => {
  const h = MD.toHTML("# 标题\n\n- 甲\n- 乙\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\ncode\n```");
  for (const tag of ["<h1>", "<ul>", "<li>", "<table>", "<th>", "<td>", "<pre><code>"]) {
    assert.ok(h.includes(tag), "缺 " + tag);
  }
});

t("toHTML：文档级标签不会被注入（无 html/body/script）", () => {
  const h = MD.toHTML("普通段落");
  for (const tag of ["<html", "<body", "<script", "<style", "<iframe"]) {
    assert.ok(!h.includes(tag), "不该出现 " + tag);
  }
});

// ---------- 引文抽取与核对（cite.js）----------
t("extractQuotes：抽引号内的整句", () => {
  const q = CITE.extractQuotes("作者说「这是一句足够长的引文内容」而已。");
  assert.equal(q.length, 1);
  assert.equal(q[0].text, "这是一句足够长的引文内容");
  assert.equal(q[0].how, "引号");
});

t("extractQuotes：抽 Markdown 引用块", () => {
  const q = CITE.extractQuotes("综合如下：\n> 这是引用块里的一段原文摘录\n结束。");
  assert.equal(q.length, 1);
  assert.equal(q[0].text, "这是引用块里的一段原文摘录");
  assert.equal(q[0].how, "引用块");
});

t("extractQuotes：短于 8 字的丢掉（那些是词不是引文）", () => {
  assert.equal(CITE.extractQuotes("他说「很短」然后走了").length, 0);
});

t("extractQuotes：同一句重复出现只留一条", () => {
  const q = CITE.extractQuotes("「重复的一段引文内容」……又是「重复的一段引文内容」");
  assert.equal(q.length, 1);
});

t("windowHit：完全一致 → 1，毫不相干 → 0", () => {
  const hay = CITE.norm("当代中国政治的教科书致力于从经验层面分析");
  assert.equal(CITE.windowHit(CITE.norm("当代中国政治的教科书"), hay), 1);
  assert.equal(CITE.windowHit(CITE.norm("完全无关的另一段话语"), hay), 0);
});

t("matchQuotes：命中材料 → 报出是哪一篇（exact）", () => {
  const mats = [
    { itemID: 11, title: "甲文", text: "这是一本关于当代中国政治的教科书，致力于从经验层面分析中国政治。" },
    { itemID: 22, title: "乙文", text: "另一篇讲乡村建设运动与梁漱溟的材料。" },
  ];
  const qs = CITE.extractQuotes("如作者所言「这是一本关于当代中国政治的教科书」");
  const r = CITE.matchQuotes(qs, mats);
  assert.equal(r.length, 1);
  assert.ok(r[0].match, "应当命中");
  assert.equal(r[0].match.itemID, 11);
  assert.equal(r[0].match.kind, "exact");
});

t("matchQuotes：材料里没有 → match 为 null（不许含糊过去）", () => {
  const mats = [{ itemID: 11, title: "甲文", text: "完全是别的内容，讲的是别的题目。" }];
  const qs = CITE.extractQuotes("作者断言「这句引文在任何材料里都不存在」");
  const r = CITE.matchQuotes(qs, mats);
  assert.equal(r[0].match, null);
});

t("matchQuotes：忽略空白与标点差异仍算一致", () => {
  const mats = [{ itemID: 7, title: "丙文", text: "清朝皇权被推翻之后，中国面临一个基本任务。" }];
  const qs = CITE.extractQuotes("文中说「清朝皇权被推翻之后 中国面临一个基本任务」");
  const r = CITE.matchQuotes(qs, mats);
  assert.equal(r[0].match.kind, "exact");
});

t("matchQuotes：空材料不炸，一律判未命中", () => {
  const qs = CITE.extractQuotes("「一段足够长的引文内容」");
  const r = CITE.matchQuotes(qs, []);
  assert.equal(r[0].match, null);
});

// ---------- 结果 ----------
console.log("");
if (failures.length) {
  console.log("失败 " + failures.length + " 项 / 通过 " + pass + " 项");
  for (const f of failures) console.log("  - " + f.name + "：" + f.msg);
  process.exit(1);
}
console.log("全部通过（" + pass + " 项）");
