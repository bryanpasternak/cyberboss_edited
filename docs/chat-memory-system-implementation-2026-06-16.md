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

---

## DeepSeek 集成 (2026-07-04)

### 改造目标

在保持 raw events 实时采集不变的前提下，用 DeepSeek 替代/增强两个环节：
1. **记忆压缩**：每 12 小时 (3:00 / 15:00) 由 DeepSeek 总结新对话为结构化记忆卡片
2. **召回过滤**：检索时由 DeepSeek 判断候选记忆与当前 5 轮上下文是否相关

### 新增文件

- `src/services/chat-memory/deepseek-client.js`
  - OpenAI-compatible chat/completions 客户端，封装 DeepSeek API
  - 支持 JSON mode (`response_format: { type: "json_object" }`)
  - 支持 undici fetch + HTTP 代理
  - `structuredPrompt()` 便捷方法：发送 system+user prompt，自动解析返回 JSON

- `src/services/chat-memory/deepseek-summarizer-service.js`
  - 定时读取新 raw events，复用 `reduceRawEventsToTurns()` 归并为 turns
  - 分批发送给 DeepSeek，每批控制在 6000 字符内
  - 解析 DeepSeek 返回的 5 类记忆卡片：`preference` | `emotion` | `event` | `fact` | `relationship`
  - 对每张卡片调用 `EmbeddingClient.embedText(title + summary)` 生成向量
  - 写入 `memories.jsonl`，进度追踪写入 `summary-state.json`
  - **Emotion 增强**：prompt 中要求 emotion 类型摘要必须包含具体情绪词（开心、感动、心疼、委屈、安心等），让文字带有情感温度

- `src/services/chat-memory/deepseek-relevance-filter.js`
  - 两阶段检索的第二阶段：向量粗排后，DeepSeek 判断候选记忆与最近 5 轮对话是否相关
  - 超时 5s，失败自动回退到纯向量排序
  - 如果 DeepSeek 判定全部不相关，回退到粗排结果（防止过于严格）

### 修改文件

- `src/core/config.js`
  - 新增 14 项配置：DeepSeek API、cron 调度、总结参数、相关性过滤
  - 新增 2 个存储路径：`chatMemoryMemoriesFile`、`chatMemorySummaryStateFile`
  - 新增 `parseCronHours()` 辅助函数

- `src/services/chat-memory/chat-memory-scheduler.js`
  - 保留原有 idle 调度逻辑
  - 新增 cron 调度：`calculateNextFireTime()` 计算下一个 3:00 或 15:00（上海时区）
  - `processCronTrigger()` 调用 summarizer 或 chunker，然后安排下一次触发
  - 进程启动时 force 处理遗漏日志

- `src/services/chat-memory/chat-memory-service.js`
  - 新增 `relevanceFilter` 注入
  - `retrieveForTurn()` 改为两阶段：向量粗排 → DeepSeek 精排
  - `loadChunks()` 合并 `memories.jsonl` + `chunks.jsonl` 两个数据源
  - 新增 `getRecentContextTurns()` 获取最近 N 轮对话
  - `formatMemoryEntry()` + `chooseMemoryLabel()` 支持 category 驱动的前缀
  - 5 种注入前缀：`「苏苏的偏好」` `「那一刻的她」` `「发生过」` `「关于苏苏」` `「你们之间」`
  - `search()` 返回新增 `category`、`title`、`emotion` 字段

- `src/services/chat-memory/index.js`
  - 按需创建 DeepSeekClient、DeepSeekSummarizer、DeepSeekRelevanceFilter
  - summarizer 传入 scheduler，relevanceFilter 传入 memory service
  - 所有新字段 additive，不影响原有 `.capture` `.scheduler` `.memory` `.promises` 接口

### 新增存储

```
.cyberboss/chat-memory/
  memories.jsonl        # DeepSeek 记忆卡片（与 chunks.jsonl 共存）
  summary-state.json    # 总结进度追踪
```

### 记忆卡片格式 (memories.jsonl)

```json
{
  "schema": "chat-memory.memory-card.v1",
  "id": "mem_000042_a1b2c3d4",
  "source": "deepseek-summary",
  "category": "emotion",
  "title": "她开心地笑了",
  "summary": "那通电话里苏苏说了很多琐碎的事，她开心地笑了很多次，语气里带着被接住的安心。阿星听着，心里也软软的。",
  "text": "[2026-07-04 12:01]\n[苏苏] 今天发生了一件特别好玩的事...\n[阿星] 说说看",
  "speakerMix": ["user", "assistant"],
  "salience": 0.65,
  "emotion": { "valence": 0.7, "arousal": 0.5 },
  "embedding": [0.001, -0.002, ...]
}
```

### Category 驱动的注入格式

| category | 前缀 | 用途 |
|---|---|---|
| `preference` | `「苏苏的偏好」` | 苏苏的偏好/习惯/边界 |
| `emotion` | `「那一刻的她」` | 情绪记忆，摘要含具体情绪词 |
| `event` | `「发生过」` | 事件、决定、完成的事 |
| `fact` | `「关于苏苏」` | 事实信息、生活状态 |
| `relationship` | `「你们之间」` | 关系进展、亲密时刻 |

### 新增环境变量

```
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED=1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_API_KEY=sk-xxx
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_MODEL=deepseek-chat
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_TIMEOUT_MS=30000
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_PROXY=
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_VERBOSE=0
CYBERBOSS_CHAT_MEMORY_CRON_HOURS=3,15
CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_TURNS_PER_BATCH=30
CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_CHARS_PER_BATCH=6000
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_ENABLED=1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_POOL_SIZE=20
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_CONTEXT_TURNS=5
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_TIMEOUT_MS=5000
```

### 关闭 DeepSeek 回退

设置 `CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED=false` 后：
- summarizer 不创建，cron 调度回退到旧 chunker（idle 触发）
- relevanceFilter 不创建，检索回退到纯向量排序
- 系统行为完全恢复到 2026-06-16 版本
