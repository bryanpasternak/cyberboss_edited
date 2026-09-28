# Cyberboss 简历技术包装（基于代码）

> 目标岗位：AI Agent 开发 / AI 应用开发 / LLM 应用开发 实习
> 本文所有结论均基于仓库代码，重要结论标注文件与位置。焦点放在 Agent / 后端 / 系统工程，不做产品需求分析。

---

## 一、整体系统架构

### 主要模块（`src/` 下按职责分层）

| 目录 | 职责 | 关键文件 |
|---|---|---|
| `src/core/` | 编排层：把渠道、runtime、集成、能力串起来，不实现具体协议 | `app.js`(3733行, `CyberbossApp`)、`channel-router.js`、`inbound-turn.js`、`stream-delivery.js`、`thread-state-store.js` 等 |
| `src/adapters/channel/` | IM 渠道适配器：收消息 / 发消息 / typing / 媒体 / 令牌 | `weixin/`、`telegram/`、`qq/` |
| `src/adapters/runtime/` | Agent 运行时适配器：把消息送入具体 Agent runtime | `codex/`、`claudecode/`、共享的 `session-store.js` |
| `src/services/` | 能力服务：记忆、欲望、提醒、日记、时间线、明信片、贴纸、小红书等 | `chat-memory/`、`desire/`、`mementos/`、`life-calendar/`、`xhs-reader.js` |
| `src/tools/` | 工具层：统一 ToolHost + 自实现 MCP stdio server | `tool-host.js`、`mcp-stdio-server.js`、`life-calendar-tool-host.js` |
| `src/app/` | 调度 / 触发器 | `system-checkin-poller.js`、`midnight-trigger.js` |
| `src/integrations/` | 独立项目集成（timeline-for-agent） | `timeline/index.js` |

### 用户消息完整调用链（以微信为例）

```
微信(iLink HTTP)
  → weixin/index.js getUpdates() 长轮询取增量
  → normalizeIncomingMessage() 归一成 provider 中立消息
  → app.js handleIncomingMessageFromChannel()
       ├─ lastActiveChannelStore.mark(senderId, "weixin")   // 更新最近活跃端
       ├─ primeDeferredRepliesForSender()                    // 补发上次没送达的内容
       └─ handlePreparedMessage()
            ├─ parseChannelCommand() 命中 /help /bind 等 → 直接本地处理
            └─ 否则 → prepareIncomingMessageForRuntime() 下载附件/视觉描述
                 → routePreparedInbound() 检查 turn-gate 是否阻塞
                 → dispatchPreparedTurn()
                      → runtimeAdapter.sendTurn()           // 送入 Agent runtime
                      → 绑定 replyTarget(threadId→渠道)
  ← Codex/ClaudeCode 流式事件(runtime.turn.started / reply.delta / completed)
  → stream-delivery.js 增量缓冲/分片 → channel.sendText() 回发到发起端
```

### 各层关系

```
IM渠道(weixin/telegram/qq) ──normalize──▶ 统一 inbound
                                              │
                              ChannelRouter（最近活跃端路由）
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
              Agent Runtime            主动消息调度              能力服务(tools)
              (codex/claudecode)       (checkin/midnight/          (memory/desire/
                    │                   reminder/promise)          reminder/timeline…)
                    │                         │                         │
                    └──── runtime event ───────┴────── 系统消息队列 ──────┘
                                    │
                            StreamDelivery（分片/重试/降级）
                                    │
                     Channel Adapter.sendText() → 回发用户
```

核心设计：**渠道与 runtime 完全解耦**。`core` 只做编排，`channel/*` 不懂 Agent 线程逻辑，`runtime/*` 不懂微信协议（见 `docs/architecture.md`）。这让"新增一个渠道 / 换一个 LLM runtime"互不影响。

---

## 二、多通道接入

### Telegram — 官方 Bot API，手写 HTTP 客户端

- 用 Telegram Bot API 的 **long polling**（`getUpdates`），不是 Webhook。证据：`src/adapters/channel/telegram/index.js:173-211` 的 `getUpdates()`。
- 手写 HTTP 客户端 `src/adapters/channel/telegram/api.js`（`getUpdates`/`sendMessage`/`sendPhoto`/`sendChatAction` 等），用 `undici` 的 fetch。
- 增量游标用 `TelegramOffsetStore`（`telegram/offset-store.js`）持久化 `update_id`，重启不丢。
- 支持 inline keyboard 回调（`telegram/inline-keyboard.js`）、媒体发送（photo/document/video/audio/voice/animation，`telegram/index.js:352-378`）、按 UTF-8 字节数分片（`splitForTelegram`，上限 4096 字节）。

### 微信 — iLink 开放机器人网关（HTTP REST + 二维码登录）

- **不是逆向微信协议**，是走官方"微信 iLink 开放机器人"网关 `https://ilinkai.weixin.qq.com`，接口前缀 `ilink/bot/*`（`core/config.js:43-47`）。
- 登录 = 终端二维码 + 长轮询确认：`weixin/login.js` 里 `fetchQrCode`/`pollQrStatus`，`qrcode-terminal` 打印二维码，状态机 `wait/scaned/confirmed/expired`。
- 轮询 `getupdates` 用 **sync buffer**（网关侧增量游标，类似 Telegram offset）+ **context token**（每用户会话令牌，发送必需，缺失即抛错），分别存于 `weixin/sync-buffer-store.js` 和 `weixin/context-token-store.js`（token 文件 chmod 600）。

### QQ — OneBot 11 协议 over WebSocket

- `qq/onebot-client.js`：OneBot 11 协议的 WebSocket 客户端，`callAction` 用 `echo` 做请求-响应对应（`crypto.randomUUID`），带 action 超时（15s）和指数退避重连（`[1s,2s,5s,10s,30s]`）。
- 部署用 NapCat Docker（`deploy/napcat/compose.yaml`，端口 3001）。

### 统一抽象 / normalization

**有，这是本项目的核心设计之一。** 三个渠道都实现同一套 adapter 接口：

```
getUpdates() / normalizeIncomingMessage() / sendText() / sendTyping() / sendMedia() / describe()
```

- 归一化入口 `weixin/message-utils.js` 的 `createInboundFilter().normalize()`，产出 provider 中立字段：`provider / accountId / workspaceId / senderId / chatId / messageId / threadKey / text / attachments[] / contextToken / receivedAt`。
- 去重：`buildDedupKey`（senderId|messageId|seq|createdAt）+ 5 分钟 TTL 的 `seen` Map。
- `core/app.js:385-399` 的 `handleIncomingMessageFromChannel` 是统一消费点，三个渠道共用同一下游。

---

## 三、"最近活跃端"路由（重点）

这是本项目最有辨识度的工程点之一。完整机制如下：

### 1. 状态存哪

`src/core/last-active-channel-store.js`，一个 **JSON 文件持久化**的 store（路径 `~/.cyberboss/last-active-channel.json`，`config.js:22`）。结构是 `{ [senderId]: { channelId, updatedAt } }`。

- `mark(senderId, channelId)` 写入渠道 + ISO 时间戳并落盘（`last-active-channel-store.js:34-45`）。
- `resolve(senderId)` 返回 `{ channelId, updatedAt, ageMs }`（`ageMs` = 距今毫秒，`:47-66`）。

### 2. 什么事件更新它

**只有用户真正发消息时才更新**（不是系统主动消息）：

```js
// app.js:396
this.lastActiveChannelStore.mark(normalized.senderId, channelId);
```

在 `handleIncomingMessageFromChannel` 里、`handlePreparedMessage` 之前执行。绑定身份时也会 mark（`app.js:424`、`:1510`）。

### 3. 主动消息如何选目标渠道

`src/core/channel-router.js` 的 `pickChannelForSender(senderId)`（`:47-59`），三级 fallback：

1. `lastActiveStore.resolve(senderId)` 命中且该渠道已启用 → 用最近活跃渠道；
2. 否则用 `defaultOutboundChannel`（`config.js:20`，默认 `weixin`）；
3. 否则用第一个启用的渠道。

`dispatchSystemMessage` 里就是这么选的（`app.js:1374-1375`）：

```js
const channelForSender = senderId ? this.resolveChannelForSender(senderId) : null;
```

`resolveChannelForSender` → `channelRouter.pickChannelForSender`（`app.js:186-188`）。

### 4. 如何避免同一条消息重复发到多个端

关键机制是 **replyTarget 绑定到"turn"**（`stream-delivery.js`）：

- 每个 turn 启动时绑定唯一的 `replyTarget`（`{userId, contextToken, provider, channelId}`），见 `dispatchPreparedTurn` 里 `bindReplyTargetForTurn`（`app.js:762-770`）。
- 流式事件只回发到这个 target：`resolveAdapterForTarget`（`stream-delivery.js:29-40`）先按 target 的 `channelId` 精确找渠道，找不到才 fallback 到 `pickChannelForSender`。
- 默认"回发到发起端"：`dispatchPreparedTurn` 里 `outboundChannel = resolveChannelById(prepared.channelId) || resolveChannelForSender(...)`（`app.js:691-693`）。

所以**主动消息发到"最近活跃端"且只发一端；用户消息回复回发起端且只发发起端**，不会一对多。

### 5. 用户 ID 映射 / 多平台账号映射

`src/core/identity-map-store.js`，核心是 `channel::externalId → canonicalSenderId` 的绑定表：

- 用户在微信发 `/link` 得到一个 **6 位短码**（`issueLinkCode`，TTL 10 分钟，`:134-151`，字符集去掉了易混淆的 `0/O/1/I`）。
- 在另一端发 `/link <code>` 消费短码（`consumeLinkCode`，`:153-174`），写入绑定 `link({channel, externalId, canonicalSenderId})`。
- 之后两个平台映射到同一个 `canonicalSenderId`，**共享同一份对话上下文（同一个 thread）**。

绑定在 Telegram 的 normalize 里自动解析（`telegram/index.js:301-303` 调 `identityMapStore.resolveCanonical`），未绑定的外部用户会收到引导提示（`app.js:401-442`）。

---

## 四、主动消息 / 主动式 Agent

### 1. 触发方式（不是单一 cron，是多源）

| 触发源 | 机制 | 证据 |
|---|---|---|
| **system check-in** | 独立 `while(true)` 循环 + **均匀随机间隔**（默认 3–60 分钟，可热改） | `src/app/system-checkin-poller.js` `pickRandomDelayMs`(140-145)、`checkin-config-store.js:4-5` |
| **midnight** | 每天 3 点后一次，按自然日去重 | `src/app/midnight-trigger.js` `checkAndFire`(51-92) |
| **reminder** | 到期触发，主循环 `flushDueReminders` | `app.js:1305-1327` |
| **promise 到期** | 每轮主循环扫描 | `app.js:1329-1362`、`promise-service.js:117-139` |
| **位置事件** | geofence / 移动事件驱动（事件驱动而非定时） | `app.js:464-513` `handleLocationAccepted` |

### 2. 如何判断"现在该主动找用户"

**check-in 本身不做"距上次活跃多久"的空闲门控**（这点要如实说明）。它的就绪条件只有两个：时间到了随机延迟 + 队列里没有待处理系统消息（防止堆积/撞车）。真正的"离上次活跃"信息存在 **desire 系统的 `lastUserAt`**（`desire-engine.js:209-218`），它通过 absence 时长影响 **libido 曲线 → 影响主动消息的内容倾向**，而不是触发时刻。

### 3. 主动触发与普通消息是否同一套 pipeline

**是。** 所有主动触发统一进 `SystemMessageQueueStore`（JSON 持久化 FIFO 队列）→ `SystemMessageDispatcher.buildPreparedMessage` 包成 `provider:"system"` 的 inbound → 走和用户消息完全相同的 `dispatchPreparedTurn` → `runtimeAdapter.sendTurn`（复用同一 bindingKey/thread）。证据：`dispatchSystemMessage`（`app.js:1373-1403`）。

差异只在两端：
- **入站**：system turn 注入 `SYSTEM ACTION MODE` 指令，强制模型返回单个 JSON（`system-message-dispatcher.js:43-68`）。
- **出站**：system 回复走 `flushSystemReply` + `resolveSystemReplyDelivery`（`stream-delivery.js:462-492`），比普通回复更严格（Codex 强制 JSON-only，`createSystemReplyPolicy` 在 `stream-delivery.js:1031-1055`）。

### 4. 保存的会话状态 / 下次触发时间

- 上次活跃：`desire-state.json` 里的 `lastUserAt`。
- 会话状态：`SessionStore`（bindingKey→threadId）+ `ThreadStateStore`（thread 的运行态 status/turnId/pendingApproval）。
- 下次触发时间：checkin 是每轮 sleep 后重读 `checkinConfigStore.getRange` 重新随机，不持久化精确下次时间；reminder 持久化 `dueAtMs`；promise 持久化 due window。

### 5. 取消/重置/延迟/静默/冷却

- **静默（silent）**：这是关键设计 —— Agent 有权选择不说话。模型返回 `{"action":"silent"}` 时 `stream-delivery.js:468-475` 直接丢弃不打扰用户。
- **单 turn 状态机**：`turn-gate-store.js` 保证每用户/工作区同时只跑一个 turn；忙时新消息 `bufferPendingInboundMessage`（`app.js:1002-1036`），结束后 `flushPendingInboundMessages` 补发。
- **投递降级**：微信 context_token 失效(errcode -2) → `deferred-system-reply-store` 挂起，等用户下次发消息补发前缀（`stream-delivery.js:607-634`）；Telegram 投递失败 → `delivery-failure-store`（去重、200 上限、下次轮询补通知）。
- **反骚扰节流**：promise 注入冷却（30min/6h）+ 次数上限(3)+过期归档；desire 关键词触发 30s 冷却；checkin 队列非空跳过。

---

## 五、Agent 实现

### 1. 模型与 API

**不是直接调某个 LLM API，而是把 OpenAI Codex CLI / Claude Code CLI 当作 Agent runtime 来驱动**（`createRuntimeAdapter`，`app.js:71-76`）：

- **Codex runtime**：`src/adapters/runtime/codex/rpc-client.js`，手写的 **JSON-RPC over stdio（spawn 子进程）或 WebSocket** 客户端，方法 `thread/start`、`turn/start`、`thread/resume`、`thread/compact/start`、`turn/interrupt`、`model/list`。模型通过 `model`/`modelProvider`/`effort`（reasoning effort 枚举 minimal~ultra，`codex/index.js:271-273`）参数配置。
- **Claude Code runtime**：`claudecode/process-client.js` 驱动 `claude` CLI 子进程，`claudecode/index.js` 管理 per-workspace 的进程池。

另外记忆系统直接调 **DeepSeek chat/completions**（`chat-memory/deepseek-client.js`，默认 `deepseek-chat`，`response_format:{type:"json_object"}`），用于摘要和相关性重排。

### 2. Tool Calling / Function Calling

**有，通过自实现的 MCP server 暴露工具给 Agent**（不是原生 OpenAI function calling）。链路：

```
Codex/ClaudeCode CLI  ←MCP stdio→  mcp-stdio-server.js  →  tool-host.invokeTool()
```

- `src/tools/mcp-stdio-server.js`：**手写的 MCP over stdio 服务**（JSON-RPC 2.0），支持 `initialize`/`tools/list`/`tools/call`/`resources/*`，帧协议双模自适应（Content-Length 头 或 逐行 JSONL）。
- 注册方式：`codex/mcp-config.js` 把 `cyberboss_tools` 写成 Codex CLI 的 MCP server 参数（每个 tool `approval_mode=auto`）；`claudecode/project-settings.js` 写进工作区 `.mcp.json`。

### 3. 有哪些 tools

**36 个内置 tool**（`tool-host.js` `PROJECT_TOOLS` 数组）+ 10 个 life-calendar tool + whereabouts（外部包）。覆盖：xhs 阅读、聊天记忆搜索、日记、纪念物/礼物/明信片/旅行卡、提醒、欲望状态/喂念头/结算、渠道发文件、贴纸、时间线读写/截图/构建。每个 tool 是声明式对象 `{name, description, inputSchema, handler}`。

### 4. 何时调用工具 / 多步调用 / planner

- **没有显式 planner/router/workflow 引擎**，靠 Codex/ClaudeCode 自身 agentic 能力决策调用哪个 tool（这正是"驱动现成 agent CLI"这种架构的特点）。
- 但有一个**显式多步状态机**：**compact 流程**（`app.js:1914-1996`），`preSave → compact → postReload` 三步，由 `pendingOperationByRunKey` 记住阶段，每步结果回来自动推进下一步。这是"手写多步编排"的证据。
- 另有 **reply self-review**（回复自审，`reply-self-review.js`）和 **approval 流程**（`waiting_approval` 状态，`thread-state-store.js:56-69`）。

### 5. 结构化输出

- **system turn 强制 JSON**：`{"action":"silent"}` / `{"action":"send_message","message":"..."}`，`stream-delivery.js:938-1055` 解析，含容错（剥 ```json 围栏、剥 `json:` 前缀、从文本里提取最后一段合法 JSON）。
- **DeepSeek jsonMode**：`deepseek-client.js:82-84` 附加 `response_format:{type:"json_object"}`，摘要/重排返回结构化字段。
- **JSON Schema 校验**：每个 tool 的 `inputSchema` 在调用前用递归校验器 `validateSchema`（`tool-host.js:1079-1132`）做类型/必填/白名单校验。

### 6. retry / fallback / validation / timeout

- **重试**：`stream-delivery.js` `sendTextWithRetry`（`:559-605`）刷新 context token 重试 → 再失败走 deferred；渠道轮询 `app.js:380` 指数退避（2s→30s，3 次连续失败）；OneBot 重连退避。
- **fallback**：远程 embedding 失败自动回退本地 hash-ngram（`embedding-client.js:26-33`）；DeepSeek rerank 全不相关回退向量粗排（`deepseek-relevance-filter.js:183-186`）。
- **validation**：tool 入参 schema 校验；reminder/promise 时间解析校验。
- **timeout**：RPC 请求超时、OneBot action 15s、DeepSeek 30s、微信长轮询 35s、XHS 60s。

---

## 六、上下文、Memory 和权限

### 1. 会话上下文怎么保存/读取

`src/adapters/runtime/codex/session-store.js`（`SessionStore`），单 JSON 文件。核心是 `bindingKey = workspaceId:accountId:senderId`（`:399-401`）到 `threadId` 的映射，按 workspaceRoot 分层。还存 runtime params（model/effort）、审批 allowlist、模型目录缓存、下一个开场上下文队列。

### 2. 短期 / 长期 memory

这是一个**完整的事件溯源式记忆系统**（`src/services/chat-memory/`）：

- **短期（raw 事件流）**：`chat-capture-service.js` 把每条 user/assistant 消息按天追加成 `chat-memory.raw.v1` JSONL，供"最近 N 轮上下文"重放。
- **长期（语义层）**：scheduler 按 cron（上海时区每天 3/15 点）+ 启动补偿 + idle，把 raw 蒸馏成 chunk（`chunk.v1`）或 LLM 记忆卡片（`memory-card.v1`）。
- **embedding**：默认本地 hash-ngram 512 维（中文 unigram+bigram），可选 DashScope/OpenAI 远程（失败自动降级本地）。
- **检索**：混合打分 `向量0.45 + 词法0.25 + 近因0.12 + 显著度0.12 + 时间词0.06`（`chat-memory-service.js:299-312`）→ 可选 DeepSeek 重排 → 注入下一轮 prompt（2400 字符预算）。

### 3. 多渠道上下文是否共享

**共享。** 通过 identity-map 把 Telegram/QQ 的 externalId 映射到同一个 `canonicalSenderId`，从而命中同一个 `bindingKey` → 同一个 thread。绑定成功时提示语就是"各端共享同一份对话上下文"（`app.js:427`）。

### 4. "只能使用用户已读内容"这类权限怎么实现

这类限制在代码里主要是**工程手段而非纯 prompt**：

- **沙箱限制 Agent 文件访问**：`rpc-client.js:420-439` 的 `buildExecutionPolicies`，非 full-access 时 `sandboxPolicy={type:"workspaceWrite", writableRoots:[workspaceRoot, stateDir], networkAccess:true}` + `approvalPolicy:"on-request"`。Agent 只能写指定根目录。
- **`/bind` 路径校验**：`app.js:1642-1649` 强制路径必须在 home 或 cwd 内（`isPathWithinAllowedDirectories`）。
- **审批（approval）**：Codex 的 command/MCP 审批请求被映射成 `runtime.approval.requested`，进入 `waiting_approval` 状态，需用户在 IM 里回 `/yes` `/no` 才继续（`app.js:2213-2268`）。
- **协议泄漏防护**：`codex/protocol-leak-monitor.js` 用正则清洗 Agent 回复里可能泄漏的内部工具调用元数据（`functions.<name>`、`tool_uses` 等），在发用户前截断（`stream-delivery.js:934`）。
- **context token 权限**：微信 context token 是敏感凭据，存盘 chmod 600（`context-token-store.js:44`）。

### 5. 防止 Agent 读到不该读的数据的工程措施

- sandbox writableRoots + approvalPolicy（上）。
- 主动消息的 system turn 用独立策略：Codex 强制 JSON-only，明文内容里有 tool 标记就直接判定非法丢弃（`containsPlainTextSystemHazard`，`stream-delivery.js:1019-1029`）。
- 记忆检索按 `bindingKey/workspaceRoot/accountId` 过滤（`chat-memory-service.js:350-373`），多主体隔离。

---

## 七、后端工程

### 语言/框架/数据库

- **语言**：Node.js（`engines: >=22`），CommonJS（`package.json`）。
- **框架**：**几乎没有 Web 框架**，纯手写。依赖极精简（见 `package.json`）：`undici`(HTTP)、`ws`(WebSocket)、`sharp`(图像)、`playwright-core`(截图)、`qrcode-terminal`、`dotenv`、两个 github 依赖 `timeline-for-agent` / `whereabouts-mcp`。
- **数据库**：**无传统数据库**。全部用 JSON 文件（状态/配置）+ JSONL 追加日志（事件溯源），用 schema 版本化（`chat-memory.raw.v1` 等）区分。

### API 组织

没有 HTTP 服务端（除了 desire panel `desire/desire-panel-server.js` 和 whereabouts location server）。对外能力全部通过 **MCP stdio** 暴露，内部用方法调用。

### 异步任务/队列/定时

- **队列**：多个 JSON 持久化 FIFO 队列 —— systemMessageQueue、reminderQueue、deferredSystemReplyQueue、deliveryFailureQueue、timelineScreenshotQueue。
- **定时**：checkin 随机循环、midnight 每日一次、chat-memory 的 cron 调度器（`chat-memory-scheduler.js`）。

### 日志/异常/重试/幂等/并发

- **异常**：`index.js:84-93` 全局 `unhandledRejection`/`uncaughtException` hook。
- **重试**：渠道轮询指数退避、context token 刷新重试、delivery failure 重试、提醒失败 5s 重入队。
- **幂等**：Telegram offset、微信 sync buffer + dedup key、chat-memory 文件锁（token+TTL+owner，`chat-memory-chunker-service.js:134-188`）+ 逐事件游标 `processedEventIds`、state 文件原子写（tmp+rename，`jsonl.js:47-74`）。
- **并发**：`turn-gate-store` 单 turn 门闩。

### 缓存

- embedding 缓存（`embeddings-cache.jsonl`）、XHS 6 小时缓存（`xhs-reader.js`）、模型目录缓存（`session-store.js` 的 `availableModelCatalog`）。

### Docker / 部署 / CI/CD

- **Docker**：`deploy/napcat/compose.yaml`（NapCat，用于 QQ，端口 6099/3000/3001）。
- **CI/CD**：未发现 CI 配置（无 `.github/workflows`）。

### 测试

- **有，且较全**：35 个测试文件，用 `node:test` + `node:assert/strict`（见 `test/*.test.js`，如 `stream-delivery.test.js` 用 `require("node:test")`）。覆盖 codex-rpc-client、approval、stream-delivery、tool-host、chat-memory、desire、memento、telegram/weixin chunks、qq-adapter、xhs-reader 等。注意 `package.json` 里**没有 `test` script**，测试是直接 `node --test` 跑（这点写简历时别写成"npm test 一键跑通"，要如实说明）。

---

## 八、能写进简历的技术栈（仓库确实用到的）

```
Languages:        JavaScript (Node.js ≥22, CommonJS)
Frameworks:       (自研无框架) 自实现 MCP server / JSON-RPC 客户端 / 事件驱动编排
LLM / Agent:      OpenAI Codex CLI (JSON-RPC 驱动) · Claude Code CLI · DeepSeek (chat/completions, JSON mode)
                  · 手写 Tool Calling 链路 (MCP) · reasoning effort 分级 · 结构化输出 JSON action 协议
Database:         无传统 DB —— JSON 文件 + JSONL 追加日志（事件溯源）、schema 版本化、原子写、文件锁
Infrastructure:   Node.js 长轮询 · WebSocket · stdio 子进程 · Docker (NapCat compose) · 随机/定时调度器
APIs / Platforms: Telegram Bot API · 微信 iLink 开放机器人网关 · OneBot 11 (QQ/NapCat) · DeepSeek · DashScope/OpenAI 兼容 embeddings
Tools:            MCP (Model Context Protocol) · 自研 46+ ToolHost · playwright-core(截图) · sharp(图像)
                  · undici(HTTP) · ws(WebSocket) · qrcode-terminal · node:test
```

---

## 九、最有含金量的工程点（面试官视角）

### ① 多通道统一抽象 + "最近活跃端"智能路由 + 跨平台身份合并

- **解决了什么**：一个 AI 陪伴体要同时活在微信/Telegram/QQ 三个端，且"主动找用户"时必须知道该往哪个端发、且只发一次。
- **实现了什么**：`channel-router.js` 三级 fallback 路由；`last-active-channel-store.js` 持久化每用户最近活跃渠道；`identity-map-store.js` 用 6 位短码把多平台账号合并成 canonical 身份，共享同一 thread。
- **为什么不是简单 CRUD**：这是"多端一致会话 + 主动消息投递目标决策"的分布式一致性问题的轻量解法，涉及归一化、状态持久化、幂等（replyTarget 绑定 turn 防重复投递）、身份映射四件事一起做。
- **面试官可能追问**：短码绑定怎么防重放/过期？last-active 是文件存储，并发写会丢吗？为什么不用 webhook 而用 long polling？跨端上下文怎么做到共享同一 thread？
- **证据**：`src/core/channel-router.js`、`last-active-channel-store.js`、`identity-map-store.js`、`stream-delivery.js:29-59`。

### ② 把 Agent CLI 当 runtime 驱动 + 自实现 MCP 工具面

- **解决了什么**：不需要自己重造 Agent loop，直接把 Codex/ClaudeCode CLI 抽象成可插拔 runtime，再通过自写 MCP server 把 46+ 业务工具喂给它们。
- **实现了什么**：`rpc-client.js` 手写 JSON-RPC over stdio/WebSocket；`mcp-stdio-server.js` 手写 MCP 协议（双帧模式自适应）；`tool-host.js` 数据驱动的工具注册表 + JSON-Schema 运行时校验 + schema 自动生成描述签名。
- **为什么不是简单 CRUD**：这是"手写协议适配层"——不依赖任何 MCP SDK，从零实现 JSON-RPC 成帧、请求-响应对应、流式事件分发；且工具元数据（schema→描述→校验）形成闭环，是典型的 Agent 基础设施。
- **面试官可能追问**：MCP 和 OpenAI function calling 有什么区别？stdio 成帧 Content-Length vs JSONL 为什么要两种？approval_mode=auto 意味着什么安全风险？工具 schema 校验失败怎么处理？
- **证据**：`src/adapters/runtime/codex/rpc-client.js`、`src/tools/mcp-stdio-server.js`、`src/tools/tool-host.js`。

### ③ 事件驱动流式转发 + 增量分片投递 + 协议泄漏防护

- **解决了什么**：Agent 是流式输出，但微信/Telegram 有消息长度和投递限制；且 Agent 的中间输出可能泄漏内部工具调用元数据。
- **实现了什么**：`codex/events.js` 把 Codex 私有消息归一成统一 `runtime.*` 事件；`stream-delivery.js` 做增量缓冲（`IncrementalReplyBuffer`）、按 UTF-8 字节分片、markdown 转纯文本、`protocol-leak-monitor.js` 正则截断协议泄漏。
- **为什么不是简单 CRUD**：这是"流式数据在异构协议边界上的有损安全转换"，处理了 delta 累积、thinking 与 reply 分流、投递失败重试/降级三级策略。
- **面试官可能追问**：delta 和 snapshot 两种 textMode 怎么处理？增量投递如果中途失败怎么回退到完整消息？怎么判断一段文本是"协议泄漏"该截断？
- **证据**：`src/core/stream-delivery.js`、`src/core/incremental-reply-buffer.js`、`src/adapters/runtime/codex/protocol-leak-monitor.js`、`events.js`。

### ④ 主动式触发系统：多源调度 + 队列 + 单 turn 状态机 + 可静默

- **解决了什么**：AI 要"主动"找用户，而不是被动响应；但要可控、不骚扰、不重复。
- **实现了什么**：checkin 随机间隔调度 + midnight 每日去重 + reminder/promise/位置事件多源统一入 `SystemMessageQueueStore` → 复用同一 Agent pipeline；`turn-gate-store` 单 turn 门闩；Agent 可返回 `{"action":"silent"}` 选择沉默。
- **为什么不是简单 CRUD**：把"何时主动"（调度）和"如何不打扰"（静默协议、节流、冷却、投递降级）做成了一套状态机 + 队列 + 结构化动作协议的完整闭环。
- **面试官可能追问**：随机间隔和固定 cron 相比优劣？怎么保证主动消息不打断正在进行的对话？silent 动作协议如何约束模型稳定输出？
- **证据**：`src/app/system-checkin-poller.js`、`src/core/system-message-queue-store.js`、`src/core/turn-gate-store.js`、`src/core/stream-delivery.js:938-1055`。

### ⑤ 事件溯源式长期记忆 + 混合检索（RAG 变体）+ LLM 重排

- **解决了什么**：陪伴型 Agent 需要"记得"长期关系事实，且不能只靠塞全量历史。
- **实现了什么**：raw 事件按天 JSONL 溯源 → cron 蒸馏成 chunk/记忆卡片 → 本地 hash-ngram 512 维 embedding → 混合打分检索 → DeepSeek 结构化重排 → 2400 字符预算注入 prompt；外加"承诺"(promise) 子系统的到期触发提醒。
- **为什么不是简单 CRUD**：这是从零搭的 RAG 全链路，且工程细节扎实（文件锁防并发、游标幂等、远程 embedding 降级、LLM 重排回退）。
- **面试官可能追问**：为什么不用向量数据库？本地 hash-ngram 和真 embedding 的差距？重排为什么用独立 DeepSeek 而不是主模型？怎么保证不把过期记忆注入？
- **证据**：`src/services/chat-memory/` 整个目录。

---

## 十、简历素材草稿（技术事实版，未过度包装）

```
• 设计并实现「最近活跃端」路由机制，维护 per-user 的 last-active-channel 状态，
  结合多平台账号映射（6 位短码绑定）将主动消息路由至最近活跃渠道，并通过
  replyTarget 绑定 turn 保证单端投递不重复（channel-router.js / last-active-channel-store.js）。

• 构建多通道接入层：为 Telegram Bot API、微信 iLink 网关、QQ OneBot(WebSocket)
  实现统一的 adapter 接口（getUpdates / normalizeIncomingMessage / sendText），
  将异构消息归一为 provider 中立结构后进入同一下游（adapters/channel/*）。

• 基于 Codex/ClaudeCode CLI 构建 Agent 运行时，手写 JSON-RPC(stdio/WebSocket) 客户端
  与 MCP stdio server，向 Agent 暴露 46+ 工具（含 JSON Schema 运行时校验），
  并通过统一 runtime.* 事件驱动流式转发与分片投递（adapters/runtime/* / tools/*）。

• 实现主动式触发系统：随机间隔 check-in + 每日 midnight + reminder/promise/位置事件
  多源统一入持久化队列，复用同一 Agent pipeline，配合单 turn 状态机、silent 静默协议
  与投递失败降级（system-checkin-poller.js / turn-gate-store.js / stream-delivery.js）。

• 从零实现事件溯源式长期记忆（raw JSONL → cron 蒸馏 → 本地 512 维 embedding →
  混合打分检索 + DeepSeek 结构化重排 → prompt 注入），含文件锁/游标幂等/远程降级
  （services/chat-memory/*）。
```
