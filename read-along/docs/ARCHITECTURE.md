# 共读模块架构与通知机制

## 一、系统概述

`read-along` 是一个"人机共读"系统，部署为独立 Node.js 服务，监听 `18004` 端口。纯原生 `http` 模块实现，无框架依赖。

### 核心工作流

```
手机浏览器 (reader.html) ──心跳/翻页──→ Node 后端 (server.js) ──停留判定──→ 推送桥 (lib/push.js) ──系统消息队列──→ AI 聊天线程
       │                                        │
       └── 写批注 / 查批注 ──────────────────────┘
                              ←── AI 写批注 (POST /api/annotate) ──
```

---

## 二、文件结构

| 文件 | 说明 |
|---|---|
| `server.js` | 后端入口：HTTP 路由、心跳处理、停留判定、批注 CRUD、门禁系统 |
| `lib/store.js` | 存储层：JSON 文件读写、原子替换、进度/批注/书签 CRUD |
| `lib/push.js` | 推送桥：三模式（cyberboss 队列 / webhook / dry-run） |
| `lib/epub.js` | EPUB 解析器 |
| `lib/txt.js` | TXT 解析器（自动编码检测 + 章节切分） |
| `lib/import.js` | 导入核心：解析结果写入书库 |
| `web/reader.html` | 前端单文件阅读器（书架 + 阅读器 + 批注对话，全部内联） |

### 数据文件（`data/` 目录，运行时生成）

| 路径 | 内容 |
|---|---|
| `data/state.json` | 阅读进度、会话状态、推送范围、全局设置 |
| `data/books/<id>/manifest.json` | 书名、作者、章节信息 |
| `data/books/<id>/chapters/<idx>.json` | 每章的分段文本 |
| `data/annotations/<bookId>.json` | 批注数据 |
| `data/bookmarks/<bookId>.json` | 书签数据 |

---

## 三、API 路由一览

### 书库与阅读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/books` | 列出所有书籍及进度 |
| GET | `/api/book/<bookId>` | 单本书详情 |
| GET | `/api/book/<bookId>/chapter/<idx>` | 获取某章全文 |
| GET | `/api/cover/<bookId>` | 封面图片 |
| POST | `/api/import` | 上传导入书籍 |
| POST | `/api/beat` | 阅读心跳（open / page / beat / close） |
| GET/POST | `/api/settings` | 停留推送时长配置 |

### 批注

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/annotations/<bookId>` | 获取某书全部批注 |
| POST | `/api/annotations` | 人类写批注（精确锚点定位） |
| POST | `/api/annotate` | AI 写批注（原文引用 + 门禁检查） |
| POST | `/api/annotations/<bookId>/<annoId>/comment` | 在某条批注下回复 |
| GET | `/api/annotations/<bookId>/poll?since=<ISO>` | 🆕 轮询新增 AI 批注/回复 |

### 书签

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bookmarks/<bookId>` | 获取书签列表 |
| POST | `/api/bookmarks` | 创建书签 |
| DELETE | `/api/bookmarks/<bookId>/<markId>` | 删除书签 |

### AI 门禁（gate）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/gate/<bookId>` | 已解锁章节和推送范围 |
| GET | `/api/gate/<bookId>/text?from=&to=` | 回看已解锁段落（最多 200 段） |
| GET | `/api/gate/<bookId>/search?q=` | 检索已解锁文本 |

---

## 四、数据流详解

### 4.1 阅读推送流程

```
前端每 10s 发心跳 (event: "beat")
  → handleBeat() 更新 pending 状态
  → evaluatePending() 检查停留是否超过 dwellMs（默认 15s）
  → 超过：取 pushedRanges 中未覆盖的段落
  → pushPage() → enqueueSystemMessage() → 追加到 ~/.cyberboss/system-message-queue.json
  → 更新 pushedRanges（区间合并，防重复推送）
```

### 4.2 推送消息类型

| 事件 | 触发条件 | 消息格式 |
|---|---|---|
| 开卷 | 用户打开书（合卷 2 分钟后重开才推送） | `【共读·开卷】TA翻开了《书名》…` |
| 正文推送 | 页面停留超 dwellMs | `【共读】TA正读到《书名》章节：\n正文\n（进度x%）` |
| 合卷 | 返回书架 / 心跳超时 5 分钟 | `【共读·合卷】TA合上了《书名》…` |
| 🆕 批注 | 人类创建新批注 | `【共读·批注】TA在《书名》中划了这段：\n"原文"\n\nTA写道：批注内容` |
| 🆕 批注回复 | 人类回复批注 | `【共读·批注回复】TA回复了《书名》中的一条批注…` |

### 4.3 推送桥机制（lib/push.js）

```
enqueueSystemMessage(text)
  ├── READING_PUSH_WEBHOOK 有值 → POST 到指定 URL
  ├── READING_PUSH_ENABLED=1    → 写 ~/.cyberboss/system-message-queue.json（原子 rename）
  └── 都没设                     → DRY-RUN，只写 data/outbox.log
```

每次调用是独立的**原子队列追加**操作：读队列文件 → push 消息 → 写临时文件 + rename。多次并发调用由操作系统文件系统保证不冲突。

---

## 五、批注系统

### 5.1 两种批注入口

| 入口 | 调用方 | 定位方式 | 门禁 |
|---|---|---|---|
| `POST /api/annotations` | 前端（人类） | 精确锚点 `{chapter, paraIdx, startOff, endOff}` | 无 |
| `POST /api/annotate` | AI | 原文引用 `quote` 字符串模糊匹配 | 有（pushedRanges 已解锁范围） |

### 5.2 批注数据结构

```json
{
  "id": "anno_xxx",
  "seq": 42,
  "startOff": 10,
  "endOff": 35,
  "quote": "引用的原文片段",
  "createdBy": "human" | "ai",
  "createdAt": "2026-07-09T12:00:00.000Z",
  "comments": [
    { "id": "cmt_xxx", "author": "human" | "ai", "text": "...", "createdAt": "..." }
  ]
}
```

批注本身是一条记录（含引用原文 + 首条评论），后续对话通过 `comments[]` 数组盖楼。

---

## 六、双向通知机制（2026-07-09 新增）

### 6.1 人类写批注 → 推送给 AI

**触发点：**

1. **新批注**：`POST /api/annotations` → `createAnnotation({gate: false})` 保存成功后
2. **批注回复**：`POST /api/annotations/<bookId>/<annoId>/comment` → `addComment()` 当 `author === 'human'` 时

**实现方式：** 直接调用现有的 `enqueueSystemMessage()`，与正文推送走同一通道。每次调用是独立的队列追加，不影响正文推送的停留判定和 pushedRanges。

**消息格式：**

新批注：
```
【共读·批注】TA在《书名》中划了这段：
"引用的原文..."
TA写道：批注内容
```

回复：
```
【共读·批注回复】TA回复了《书名》中的一条批注：
原批注："引用的原文..."
TA写道：回复内容
```

### 6.2 AI 写批注 → 前端 Toast 通知

**后端：新增轮询端点**

```
GET /api/annotations/<bookId>/poll?since=<ISO时间戳>
```

返回自指定时间以来新增的 AI 批注和 AI 回复：
```json
{
  "hasNew": true,
  "newAiAnnotations": [ /* 新建批注 */ ],
  "newAiComments": [ /* 现有批注的新 AI 回复 */ ],
  "serverTime": "2026-07-09T12:00:05.000Z"
}
```

**前端：轮询机制**

- 阅读器打开时启动 20 秒轮询定时器
- 维护 `R.lastPollAt` 时间戳，每次轮询后更新为服务端返回的 `serverTime`
- 检测到新内容时：弹出 Toast "AI 写了 N 条新批注" → 自动刷新当前页批注高亮
- 阅读器关闭时停止轮询

**为什么是轮询而非 WebSocket：**
- 批注场景低频，20 秒延迟完全可接受
- 不引入新依赖，保持纯 HTTP 架构
- 轮询请求体积极小（~100 bytes），服务器零负担

---

## 七、环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `READING_PORT` | 18004 | 监听端口 |
| `READING_DWELL_MS` | 15000 | 停留判定时间（毫秒） |
| `READING_IDLE_MS` | 300000 | 心跳超时自动合卷（毫秒） |
| `READING_READER_NAME` | "TA" | 推送中对读者的称呼 |
| `READING_PUSH_ENABLED` | 空 | 设为 `1` 启用 cyberboss 推送 |
| `READING_PUSH_WEBHOOK` | 空 | 设为 URL 启用 webhook 推送 |
| `CYBERBOSS_STATE_DIR` | `~/.cyberboss` | cyberboss 状态目录 |

---

## 八、前端状态管理

`reader.html` 中的全局状态对象 `R`：

| 字段 | 说明 |
|---|---|
| `R.books` | 书架列表 |
| `R.book` | 当前选中的书 |
| `R.manifest` | 当前书的 manifest |
| `R.chapters` | 已缓存的章节数据 |
| `R.annos` | 批注列表 |
| `R.marks` | 书签列表 |
| `R.ch` / `R.page` / `R.pages` | 当前阅读位置 |
| `R.sessionOpen` | 会话是否开启 |
| `R.beatTimer` | 心跳定时器 |
| 🆕 `R.lastPollAt` | 上次轮询时间戳 |
| 🆕 `R.pollTimer` | 批注轮询定时器 |
