// DSH Bridge 默认首选项
// 在 Zotero 的 about:config（设置 → 高级 → 配置编辑器）里可改，
// 前缀：extensions.dshbridge.

pref("extensions.dshbridge.nodePath",
     "C:\\Program Files\\nodejs\\node.exe");

pref("extensions.dshbridge.dshBin",
     "");

// 专用 profile：以 headless 为模板，另装了
//   dsh-kb-rag（你的知识库）、dsh-lit-search、dsh-cite、dsh-zotero、dsh-obsidian
// ⚠️ 不能用 "headless" —— 那个 profile 一个插件都没装，
//    会话里没有 kb_search / lit_search / cite 等任何工具。
pref("extensions.dshbridge.profile", "dshbridge");

pref("extensions.dshbridge.timeoutSec", 600);

// 单次发送时，全文最多带多少字符（防止提示词过长）
pref("extensions.dshbridge.maxFulltextChars", 60000);

// 是否默认附带附件全文
pref("extensions.dshbridge.includeFulltext", true);

// v1.3.1 新增：日志文件路径。
//   · 留空字符串 "" = 关闭文件日志（只写 Zotero.debug，用「帮助→调试输出」看）
//   · 超过 2 MB 时自动轮转为 <该路径>.1，不会无限增长
// 以前这条路径硬编码在 bootstrap.js 与 chat.js 两处，换机器/换目录即失效。
pref("extensions.dshbridge.logPath", "");

// v1.5.0 新增：阅读器集成开关（划词浮层 / 工具栏按钮 / 批注侧栏入口）。
// 置 false 后重启 Zotero，插件不再往阅读器里注入任何东西 —— 不必卸载。
// 留这条是因为阅读器注入依赖若干**我无法静态验证**的行为
// （最要紧的一条：append 的参数会被 cloneInto 克隆进内层文档，
//   监听器能否跨克隆存活，我未验证 —— 见 bootstrap.js 的 appendAndBind 注释）。
pref("extensions.dshbridge.readerIntegration", true);

// v1.6.0 新增：对话的工作区。
// 已核实：DSH 的「工作区」= 子进程的当前工作目录（dsh 包里 plugin-BGnVfe_D.js 写着
//   `cwd: process.cwd()`），且 dsh --help 里没有 --workspace 之类的选项。
// 而插件 spawn 出来的 dsh 继承的是 **Zotero 进程的 cwd**。
// 留空 = 沿用旧行为（跑在 Zotero 的 cwd 里）；窗口顶栏的下拉框会写这一项。
pref("extensions.dshbridge.workspace", "");

// v1.6.0 新增：DSH 工作区登记表路径。
// 留空 = 自动用 ~/.dsh/storages/workspace.json（从家目录拼，不写死用户名）。
pref("extensions.dshbridge.workspaceRegistry", "");

// v1.6.0 新增：「建集合」用的集合名。同名会复用，不重复创建。
pref("extensions.dshbridge.noteCollectionName", "DSH Bridge · 会话材料");

// v1.7.0 新增：每次对话结束后，把会话号登记进 DSH 的工作区登记表，
// 使其在 **DSH 界面里直接可见，不必再走导入**。
// 已核实的必要性：DSH 界面**不扫会话桶**，只列 workspace.json 里各工作区 sessionIds 中的会话
//   （实据：会话桶里 93 个会话目录，登记表只认 29 个）。
// ⚠️ 这会写 DSH 自己的状态文件 —— 代码里有护栏（只增不删 / 写前备份 / 原子置换 /
//    解析失败就放弃），但仍然是一条侵入性路径。置 false 即可关掉，不影响对话本身。
pref("extensions.dshbridge.registerSessions", true);

// v1.8.0 新增：会话历史文件。
// 留空 = 与日志同目录的 dsh-bridge-history.json。
// 存的是**插件自己持有的对话文本**（不含 Zotero 库内容），用于窗口左侧的历史栏：
//   DSH 那边的 session 文件是 zstd 压缩的、插件解不开，所以要另存一份才能铺回消息区。
pref("extensions.dshbridge.historyPath", "");
