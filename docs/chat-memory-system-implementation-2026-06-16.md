# Chat Memory System 实现说明

日期：2026-06-16

## 范围

本次实现的是一套独立于 Ombre-Brain MCP 的聊天记忆系统，目标是：

1. 记录原始对话事件。
2. 按 turn 聚合并切块，生成可检索记忆。
3. 在新消息和新线程时做自动召回。
4. 提供微信 / Telegram 端命令控制自动召回。
5. 支持系统唤醒时注入 promise 待办检查。
6. 暴露新的项目工具 `cyberboss_memory2_search`。

## 代码结构

### 新增服务层

- `src/services/chat-memory/jsonl.js`
  - JSONL / JSON 文件读写辅助。
- `src/services/chat-memory/time.js`
  - 上海时区时间处理、时间标签抽取。
- `src/services/chat-memory/embedding-client.js`
  - 向量编码客户端，带本地 fallback。
- `src/services/chat-memory/chat-capture-service.js`
  - 原始消息、turn 结果、失败事件落盘。
- `src/services/chat-memory/chat-memory-metadata-service.js`
  - 记忆摘要、标签、情绪和 salience 提取。
- `src/services/chat-memory/chat-memory-chunker-service.js`
  - 将 raw events 聚合为 chunks。
- `src/services/chat-memory/chat-memory-scheduler.js`
  - 空闲触发的切块调度。
- `src/services/chat-memory/chat-memory-settings-store.js`
  - 自动召回开关和召回数量持久化。
- `src/services/chat-memory/chat-memory-service.js`
  - 检索、格式化注入、线程回顾。
- `src/services/chat-memory/promise-time.js`
  - promise 到期时间解析。
- `src/services/chat-memory/promise-service.js`
  - promise 捕获、到期检索、系统唤醒注入。
- `src/services/chat-memory/index.js`
  - 组装 chat-memory runtime。

### 接入层

- `src/core/app.js`
  - 接入采集、检索、自动召回、promise 注入。
  - `/new` 线程切换时生成上一线程回顾和最近记忆注入。
  - `/recall` 命令控制自动召回。
  - 系统唤醒时加入 promise 检查。
- `src/core/config.js`
  - 增加 chat-memory / promise 相关路径和环境变量。
- `src/core/command-registry.js`
  - 增加 `/recall` 到帮助和命令可见性。
  - 移除 `/memory` 入口。

### 运行时接入

- `src/adapters/runtime/codex/session-store.js`
  - 增加新线程开场上下文暂存与消费。
- `src/adapters/runtime/codex/index.js`
  - 新线程首条消息注入开场上下文。
- `src/adapters/runtime/claudecode/index.js`
  - 同步支持新线程开场上下文。

### 工具层

- `src/tools/create-project-tooling.js`
  - 让独立工具进程也初始化 chat-memory 服务。
- `src/tools/tool-host.js`
  - 暴露 `cyberboss_memory2_search`。
  - 该工具明确和 Ombre-Brain 的 `breath / grow / hold` 分开。

## 行为摘要

### 自动召回

- 普通消息进入时，会从 chat-memory 中检索相关记忆并注入到 runtime 文本。
- `/recall on|off|<number>` 用来控制自动召回开关和召回数量。
- `/recall` 仅控制新系统的自动召回，不影响 Ombre-Brain MCP。

### 新线程 `/new`

- 先收集旧线程回顾。
- 线程开场会注入：
  - 上个线程的开头和末尾 15 条连续对话。
  - 排除最后的用户 / 模型回复作为开场起点的干扰。
  - 最近几条长期记忆。
- 如果旧线程没有可用 raw log，会直接跳过回顾，保证后续逻辑仍可运行。

### 系统唤醒

- 系统消息通道会额外检查 promise 到期情况。
- 到期 promise 会以系统私有上下文形式进入模型检查链路。

### 项目工具

- 新增 `cyberboss_memory2_search`。
- 这个工具只查当前 chat-log memory，不查 Ombre-Brain MCP。

## 已知潜在问题

1. `CYBERBOSS_CHAT_MEMORY_ENABLED` 仍是总开关；没打开时，`/recall` 只能改设置，不能真正启用采集与检索。
2. 当前 image-only 批处理路径会先记 raw 事件，再在合并后再记一次，raw 层可能出现重复记录。
3. promise 存储的 archive 写入仍是追加式，`writeState()` 和 archive 文件之间可能出现重复写入。
4. 主进程和独立工具进程都会访问同一套 chat-memory 文件；并发写入没有加文件锁，存在竞态风险。
5. `/new` 的回顾依赖 raw log 已经被完整记录；如果历史很早以前没有采集数据，线程开场会变空。
6. turn 切块和回顾依赖当前 turn 归并规则；极端情况下多段回复或消息乱序会影响回顾质量。

## 备注

- Ombre-Brain MCP 记忆系统保持独立，没有被这次实现替换或合并。
- 这份实现侧重于“聊天对话记忆”和“系统承诺提醒”两条链路。


已改，还是按最小方案做的。

  现在这三处变了：

  - src/services/chat-memory/jsonl.js:47 的 writeJsonFile() 改成了“同目录临时文件写入 + 替换落盘”，避免 chunk-
    state.json、promises.json 这类状态文件被半写坏。
  - src/services/chat-memory/chat-memory-chunker-service.js:134 的锁改成了 wx 原子创建，过期锁再重试，不再靠先读后写。
  - src/services/chat-memory/promise-service.js:168 的 archive 追加只在真正归档时触发，不再跟状态保存绑在一起。

  我本来想顺手跑 node --check，但这次本地沙箱起子进程报了 CreateProcessAsUserW failed: 1312，所以没法把语法检查结果拿回
  来。代码我已经按当前文件内容核过一遍，改动很小，风险主要还在“最后写入覆盖前一个写入”的弱并发语义上，但不会再轻易把
  JSON 写坏。


新增 src/services/chat-memory/promise-classifier.js
走 OpenAI 兼容 chat/completions，强制 JSON 输出 {is_promise, confidence, reason}，6s 超时，任何异常都返回 null。

promise-service.js
- captureAssistantPromise / captureUserPromise 在 upsertPromise 前 await applyClassifier；is_promise=false 跳过、置信度回填到 candidate；classifier 没开
- retrieveDueForTurn 入口先调 sweepStalePromises：injectCount 满或窗口过期超 grace（默认 12h）的自动归档为 status: "stale"，closeReason 写明原因。
- next_time 不参与窗口归档（它本来就没固定窗口）。
- 多过滤了一道 injectCount < maxInjects。

config.js 新增环境变量：
CYBERBOSS_PROMISE_CLASSIFIER_ENABLED       # 总开关
CYBERBOSS_PROMISE_CLASSIFIER_PROVIDER      # 默认 openai-compatible
CYBERBOSS_PROMISE_CLASSIFIER_BASE_URL      # Gemini: https://generativelanguage.googleapis.com/v1beta/openai
                                           # Qwen:   https://dashscope.aliyuncs.com/compatible-mode/v1
CYBERBOSS_PROMISE_CLASSIFIER_API_KEY       # 也兼容 DASHSCOPE_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY
CYBERBOSS_PROMISE_CLASSIFIER_MODEL         # 如 gemini-2.5-flash / qwen-turbo
CYBERBOSS_PROMISE_CLASSIFIER_TIMEOUT_MS    # 默认 6000

CYBERBOSS_PROMISE_INJECT_COOLDOWN_MS       # 默认 30 分钟
CYBERBOSS_PROMISE_NEXT_TIME_COOLDOWN_MS    # 默认 6 小时
CYBERBOSS_PROMISE_MAX_INJECT_COUNT         # 默认 3 次
CYBERBOSS_PROMISE_EXPIRED_GRACE_MS         # 默认 12 小时

index.js new 出 classifier 并注入 PromiseService。

node --check 四个文件都过了。要不要我顺手在 docs/chat-memory-system-implementation-2026-06-16.md 末尾补一段改动记录？


方式二：关闭整个 chat-memory

设置 CYBERBOSS_CHAT_MEMORY_ENABLED=false 环境变量，这样 chatMemoryService.enabled 为 false，buildThreadRecap 会直接返回空字符串。
