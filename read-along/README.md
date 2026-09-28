# read-along 实时共读

**让你的 AI 陪你一页一页把书读完。**

你在手机上看书，你的 AI 实时"跟着你读"，你读的每一页原文都会随阅读实时同步给AI，你们可以在同一本书的页边划线、写批注、互相回复

市面上的"AI 读书"大多是反过来的：AI 先把整本书或某个章节吞了，然后给你讲书、划重点、写摘要。这个系统不做那件事。它做的是**陪读**——AI 和你保持同样的进度，你读一页，它也才读一页。

## 核心设计：防剧透门禁

- 你在某一页**停留超过 15 秒**，这一页的原文才会推送给 AI，然后AI阅读该页的原文，快速翻阅与历史翻阅的内容不会被推送。15 秒不是死的——阅读器设置面板里可以随时改（5–60 秒），保存后立刻生效。
- AI **无法读取你还没读到的任何内容**。不是"说好了不看"，而是系统层面就拿不到——连未读章节的标题都对它保密。
- AI 回看、搜索、写批注，范围永远只限你已经读过的部分。它写批注必须逐字引用一句你读过的原文，想"预埋"后文的批注做不到。

所以 AI 会和一个真正的共读伙伴一模一样：和你在同一页，对同一章节的后续情节也一样一无所知。它的好奇、猜测和惊讶，都是真的。

## 功能

- **网页阅读器**（单文件、零依赖）：书架、分页阅读、进度记忆、两点点选划线批注、批注对话与跳回原文
- **阅读器控制面板**：点击页面中部呼出（上一章/目录/设置/下一章）；字号、行距调节，夜间模式（手动或跟随系统）
- **书签**：夹住当前页、一键跳回；书签是读者私有的，不会推送给 AI
- **书籍与论文导入**：网页端「＋导入」支持 EPUB / TXT / TeX / PDF；TeX 公式以浏览器原生 MathML 排版，论文插图和 PDF 原页可在阅读器里查看
- **阅读事件推送**：开卷 / 每页原文 / 合卷（含本次与累计共读时长），推给你的 AI
- **批注互动**：双方划线用不同颜色区分，每条划线下可以盖楼回复
- **推送通道**：内置 cyberboss 系统消息队列支持；非 cyberboss 用户可用通用 webhook 模式

## 快速开始

### 这台 Windows 电脑上的最短用法

打开 PowerShell，先进入共读目录：

```powershell
cd C:\Users\19670\cyberboss\read-along
```

导入完整的 TeX 论文工程时，选择主 `.tex` 文件。比如当前这篇论文：

```powershell
node .\import-book.js "$env:USERPROFILE\Downloads\arXiv-2509.04664v1\MAIN_arxiv.tex" --id hallucination-paper
```

如果拿到的是单个 PDF：

```powershell
node .\import-book.js "C:\论文路径\paper.pdf" --id my-paper
```

`--id` 是书架里的内部名字：用简短、不重复的英文即可。导入后不需要在手机上安装 TeX 或 PDF 软件，刷新共读书架就能阅读。

启动连接 Cyberboss 的共读服务：

```powershell
npm run start:cyberboss
```

这个窗口需要保持打开。以后需要重启时，在运行它的窗口按 `Ctrl+C`，再执行一次 `npm run start:cyberboss`。启动后可访问 `http://127.0.0.1:18004/health` 检查服务；返回包含 `"ok": true` 就说明已经正常运行。

第一次安装依赖或 `package.json` 更新后，先在同一目录执行一次 `npm install`。日常导入新论文不需要重复安装。

### 通用安装方式

```bash
git clone https://github.com/luoluo-1121/read-along.git && cd read-along
npm install

# 先跑起来（DRY-RUN 模式：推送只写日志，不外发）
node server.js

# 导入一本书或论文（epub / txt / tex / pdf；跑起来后也可以直接在网页书架上传）
node import-book.js /path/to/book.epub --id mybook

# 多文件 TeX 项目建议从命令行导入主文件；这样会一并读取同目录的 input/include 和本地插图
node import-book.js /path/to/paper/MAIN.tex --id my-paper
```

TeX 导入需要系统 PATH 中有 `pandoc`（也可用 `READING_PANDOC_PATH` 指定）。PDF 导入依赖随项目安装的 PDF.js；当前版本在 Node.js 22.13+ / 24+ 下受支持。手机端不需要安装 LaTeX、Pandoc 或 PDF 阅读器——转换发生在服务端，手机浏览器只负责显示排好的公式、表格、图片和原始 PDF 页面。

网页上传单个 `.tex` 文件时无法同时取得它旁边的宏文件和插图；完整论文工程请用上面的命令行方式导入主 `.tex` 文件。导入之后，电脑和手机访问的是同一个普通网页阅读器。

前端：把 `web/reader.html` 放到 nginx 下，API 反代到 `127.0.0.1:18004`（详见 [docs/DEPLOY.md](docs/DEPLOY.md)）。

### Codex MCP

仓库根目录提供一层轻量 stdio MCP 适配器，复用本服务已有的 HTTP API：

```powershell
codex mcp add read-along -- node C:\Users\19670\cyberboss\read-along\mcp-server.js
```

MCP 只可读取已经由共读推送解锁的正文，并可列出批注、写 AI 批注和回复批注。HTTP
后端仍需通过 `npm start` 单独运行；可用 `READ_ALONG_BASE_URL` 修改默认地址
`http://127.0.0.1:18004`。

Cyberboss 本机共读可直接使用：

```powershell
npm run start:cyberboss
```

该入口默认开启正文推送、将读者名设为“苏苏”，并使用当前用户目录下的
`.cyberboss` 状态目录；仍可通过同名环境变量覆盖这些默认值。

联调通过后，开启真实推送：

```bash
# cyberboss 用户
READING_PUSH_ENABLED=1 READING_READER_NAME=你的名字 node server.js

# 其他用户：给一个能收 HTTP POST 的 webhook
READING_PUSH_WEBHOOK=https://your-bridge/webhook node server.js
```

完整的部署步骤（nginx、HTTPS、pm2 常驻、AI 侧接入、排错）见 **[docs/DEPLOY.md](docs/DEPLOY.md)**。AI 侧的批注操作指南见 **[docs/AI-GUIDE.md](docs/AI-GUIDE.md)**。

## 架构

```
手机浏览器（web/reader.html）
    │ HTTPS · 翻页心跳每10秒
    ↓
nginx（反向代理）
    ↓
共读后端 Node 服务（127.0.0.1:18004）
书库 API · 心跳/停留判定 · 批注存储 · 门禁读取
    │ 推送
    ↓
cyberboss 系统消息队列 / 你的 webhook
    ↓
你的 AI 的聊天线程
```

数据全部是本地 JSON 文件（`data/` 目录），无数据库，写入原子替换。备份 = 打包 `data/`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `READING_PORT` | `18004` | 监听端口（仅绑 127.0.0.1） |
| `READING_DWELL_MS` | `15000` | 一页停留多少毫秒算"读过"（也可在阅读器设置面板里直接改，面板设置存 state.json、优先于此值） |
| `READING_IDLE_MS` | `300000` | 心跳断多久自动判定合卷 |
| `READING_PUSH_ENABLED` | 空 | `=1` 时写 cyberboss 系统消息队列 |
| `CYBERBOSS_STATE_DIR` | `~/.cyberboss` | cyberboss 状态目录 |
| `READING_PUSH_WEBHOOK` | 空 | 设了则改走 webhook（优先于 cyberboss） |
| `READING_READER_NAME` | `TA` | 推送文案里对读者的称呼 |

两个推送开关都不设 = DRY-RUN，只记 `data/outbox.log` 不外发。

## 注意

- 本方案没有内置登录。书和批注是私人内容，网页导入口也同样对能访问到该路径的人开放，建议加一层 nginx Basic Auth 或使用不可猜测的路径。
- 请只导入你有权阅读的书籍文件，不要把书籍数据（`data/`）提交进任何公开仓库。
- **推送会把书的正文持续喂进 AI 的会话**：上下文占用和 token 费用都随阅读量增长（每条推送触发一次带全部历史的推理）。部署前请读 [docs/DEPLOY.md](docs/DEPLOY.md) 的「token 消耗与上下文占用」一节。

## 致谢

本项目的设计参考了两个很棒的项目：

- [cyberboss](https://github.com/WenXiaoWendy/cyberboss) — 微信接入的本地 agent 桥，让 AI 主动陪伴、感知时间地在场。read-along 的推送通道直接构建在它的系统消息队列之上，「AI 常驻于你日常的聊天窗口」这个前提也来自它。
- [co-reading-kit](https://github.com/Youxuuuuu/co-reading-kit) — 低 token 成本的人机协作阅读 MCP 工具箱。本地书库、分块加载、无数据库的轻量思路给了我们很多启发。

## License

MIT

---

*这一次，故事对你们都是新的。*
