# Chat Memory DeepSeek 集成方案

日期：2026-07-04

## 1. 背景与目标

当前 chat-memory 系统使用 Qwen (DashScope) 做向量嵌入，元数据提取完全基于规则（正则匹配），切块基于时间间隔/字数/轮次的简单启发式。用户希望引入 DeepSeek 的语义理解能力，在两个关键环节替换/增强：

1. **记忆压缩（总结）**：每 12 小时（凌晨 3 点和下午 3 点），把新聊天记录交给 DeepSeek 总结成事件、情感发展、偏好/事实等结构化记忆卡片，再做向量计算。
2. **召回过滤（相关性判断）**：召回时由 DeepSeek 检查当前上下文（最近 5 轮对话）与候选记忆是否真正相关，替代纯向量相似度 + 规则排序。

**不变的部分**：原始聊天记录的实时采集（raw events 落盘）完全不动。

---

## 2. 现状回顾

### 2.1 当前管线

```
用户消息到达
  → ChatCaptureService.appendUserReceived()     # raw/YYYY-MM-DD.jsonl
  → (turn 完成后)
  → ChatCaptureService.appendTurnLinked()
  → ChatCaptureService.appendAssistantCompleted()

空闲 20 分钟 或 进程启动
  → ChatMemoryScheduler 触发
  → ChatMemoryChunkerService.processDueLogs()
    → reduceRawEventsToTurns()                  # raw events → turns
    → buildChunksFromTurns()                    # 按 gap/字数/轮数切块
    → ChatMemoryMetadataService.extractMetadata()  # 规则提取: summary, tags, salience, emotion
    → EmbeddingClient.embedText()               # Qwen text-embedding-v3 (或 local fallback)
    → 写入 chunks.jsonl

每次用户消息
  → ChatMemoryService.retrieveForTurn()
    → embedQuery(query)                         # Qwen 嵌入查询文本
    → 遍历 chunks.jsonl
    → rankChunk(): vector(45%) + lexical(25%) + recency(12%) + salience(12%) + time(6%)
    → Top N 注入到 runtime context
```

### 2.2 关键文件

| 组件 | 路径 |
|---|---|
| 嵌入客户端 | `src/services/chat-memory/embedding-client.js` |
| 采集服务 | `src/services/chat-memory/chat-capture-service.js` |
| 切块服务 | `src/services/chat-memory/chat-memory-chunker-service.js` |
| 元数据服务（规则） | `src/services/chat-memory/chat-memory-metadata-service.js` |
| 检索服务 | `src/services/chat-memory/chat-memory-service.js` |
| 空闲调度器 | `src/services/chat-memory/chat-memory-scheduler.js` |
| 工厂入口 | `src/services/chat-memory/index.js` |
| 应用集成 | `src/core/app.js` (line ~2121) |
| 配置 | `src/core/config.js` |

### 2.3 当前问题

- **元数据提取粗糙**：纯正则匹配，无法理解对话语义。例如"我不太确定要不要继续"被归为 `emotion` + `relationship`，但实际可能是一个重大的项目方向转折。
- **切块盲目**：按 1200 字符 / 10 分钟间隔 / 6 轮硬切，可能把一段连贯的情感交流切成两块。
- **召回噪音**：纯向量 + 规则排序无法理解微妙的相关性，经常召回字面相似但实际无关的记忆。

---

## 3. 方案总览

### 3.1 新管线

```
用户消息到达
  → ChatCaptureService (不变)                    # raw events 落盘

定时触发 (3:00 / 15:00)
  → CronScheduler 触发
  → DeepSeekSummarizer.processDueLogs()
    → reduceRawEventsToTurns()                   # (复用) raw events → turns
    → 分批发送 turns 给 DeepSeek
    → DeepSeek 返回结构化记忆卡片 (events, emotions, facts, etc.)
    → 每张记忆卡片嵌入 (EmbeddingClient)
    → 写入 memories.jsonl

每次用户消息
  → ChatMemoryService.retrieveForTurn()
    → embedQuery(query)                          # 向量嵌入
    → 遍历 memories.jsonl, 粗排取 Top M (M > N)
    → DeepSeekRelevanceFilter.check(context=最近5轮, candidates=Top M)
    → 返回 DeepSeek 判定相关的 Top N
    → 注入到 runtime context
```

### 3.2 变化矩阵

| 组件 | 变化类型 | 说明 |
|---|---|---|
| ChatCaptureService | **不变** | raw events 采集完全保留 |
| ChatMemoryChunkerService | **保留为 fallback** | DeepSeek 禁用或失败时回退 |
| ChatMemoryMetadataService | **DeepSeek 路径下不再使用** | 元数据由 DeepSeek 生成 |
| ChatMemoryScheduler | **改造** | 从 idle-based 改为 cron-based (3:00/15:00) |
| EmbeddingClient | **改造输入源** | 嵌入对象从 raw chunk text 变为 DeepSeek 摘要 |
| ChatMemoryService | **增强** | 检索管线增加 DeepSeek 相关性过滤 |
| DeepSeekClient | **新增** | OpenAI-compatible 客户端，封装 chat/completions |
| DeepSeekSummarizer | **新增** | 定时总结服务 |
| DeepSeekRelevanceFilter | **新增** | 召回相关性判断 |

---

## 4. 详细设计

### 4.1 DeepSeekClient（新增）

**文件**：`src/services/chat-memory/deepseek-client.js`

封装 DeepSeek OpenAI-compatible API 调用。与现有的 `EmbeddingClient` 类似结构，但针对 chat/completions。

```js
class DeepSeekClient {
  constructor({ config }) {
    this.baseUrl = config.chatMemoryDeepSeekBaseUrl;   // 默认 https://api.deepseek.com/v1
    this.apiKey = config.chatMemoryDeepSeekApiKey;
    this.model  = config.chatMemoryDeepSeekModel;       // 默认 deepseek-chat
    this.timeoutMs = config.chatMemoryDeepSeekTimeoutMs || 30000;
  }

  // 调用 chat/completions，支持 JSON mode
  async chatCompletion({ messages, temperature = 0.3, maxTokens = 4096, jsonMode = false }) { ... }

  // 便捷方法：发送 system + user prompt，返回解析后的 JSON
  async structuredPrompt({ systemPrompt, userContent, maxTokens = 4096 }) { ... }
}
```

**配置环境变量**：

```
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED=1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_API_KEY=sk-xxx
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_MODEL=deepseek-chat
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_TIMEOUT_MS=30000
```

**关键设计决策**：
- 复用 OpenAI-compatible 协议（`/chat/completions`），与现有 `promise-classifier.js` 的模式一致
- 支持通过 `CYBERBOSS_CHAT_MEMORY_DEEPSEEK_PROXY` 配置代理（已有基础设施）
- JSON mode：通过 `response_format: { type: "json_object" }` 确保结构化输出
- 错误处理：超时/网络错误 → 返回 null，上层 fallback 到旧 chunker

---

### 4.2 DeepSeekSummarizer（新增，替代 Chunker + MetadataService）

**文件**：`src/services/chat-memory/deepseek-summarizer-service.js`

**职责**：
1. 读取上次总结之后的新 raw events
2. 复用 `reduceRawEventsToTurns()` 归并为对话轮次
3. 分批发送给 DeepSeek（每批控制在 token 限制内，如 ~3000 tokens 原文）
4. 解析 DeepSeek 返回的结构化记忆卡片
5. 对每张记忆卡片调用 `EmbeddingClient.embedText()` 生成向量
6. 写入 `memories.jsonl`
7. 更新 `summary-state.json` 记录处理进度

**核心流程**：

```
processDueLogs({ now, force = false })
  → 获取锁 (processing-lock.json, 复用现有锁机制)
  → 列出 raw/ 文件
  → 读取 summary-state.json 获取上次处理位置
  → 筛选新 events (eventId 不在 processedEventIds 中)
  → reduceRawEventsToTurns() → turns
  → 如果 turns 为空，跳过
  → batchTurns(turns, maxTokensPerBatch) → batches
  → for each batch:
      → summarizeBatch(batch) → memoryCards[]
      → for each card:
          → embedding = embedText(card.title + "\n" + card.summary)
          → 写入 memories.jsonl
  → 更新 summary-state.json
  → 释放锁
```

**DeepSeek 总结 Prompt 设计**：

```
System:
你是一个亲密关系的对话记忆提取器。你阅读苏苏和阿星之间的对话记录，从中提取有意义、值得未来回忆的记忆点。

你的输出必须是严格的 JSON 格式。

User:
请阅读以下对话记录，提取其中值得长期记住的内容。

对于这段对话，请提取以下类型的记忆点：
1. **preference** — 苏苏表达的偏好、习惯、边界、喜欢或讨厌的事物。**这是最重要的一类**，需要精确捕捉。
2. **emotion** — 苏苏或阿星的情绪状态、情感表达、情绪变化。**摘要中必须保留具体的情绪词**（如"开心""感动""心疼""委屈""想""爱""温暖""低落""焦虑"），让读到的人能感受到当时的情绪温度。不要用"表达了情感"这种空洞说法——说"她开心地笑了，语气里带着被接住的安心"。
3. **event** — 发生了什么具体事件、做出了什么决定、完成了什么任务。
4. **fact** — 关于苏苏的事实信息、生活细节、当前状态（作息、身体、工作等）。
5. **relationship** — 关系进展、重要互动、亲密时刻。**注意**：时间相关的承诺/约定由另一个系统专门处理，不需要在此提取。

每个记忆点必须包含：
- category: 上述类型之一
- title: 简短标题（15字以内）
- summary: 2-4句话的总结，捕捉关键信息和上下文。**emotion 类型的 summary 必须包含具体的情绪词汇**，让文字本身带有情感温度。
- salience: 0到1的重要性评分（0.5=普通, 0.7=比较重要, 0.9+=非常重要/需要记住）
- emotion_valence: -1到1的情感效价（-1=极度负面, 0=中性, 1=极度正面）
- emotion_arousal: 0到1的情感唤醒度（0=非常平静, 0.5=中等, 1=非常激动/强烈）

如果对话中没有值得提取的内容（纯寒暄、无信息量），返回空数组。

对话记录：
---
{turns_text}
---

请以以下 JSON 格式返回：
{
  "memories": [
    {
      "category": "event",
      "title": "...",
      "summary": "...",
      "salience": 0.7,
      "emotion_valence": 0.5,
      "emotion_arousal": 0.3
    }
  ]
}
```

**分批策略**：

```js
function batchTurns(turns, maxTokensPerBatch = 3000) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const turn of turns) {
    const turnChars = turn.text.length;
    if (currentChars + turnChars > maxTokensPerBatch && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(turn);
    currentChars += turnChars;
  }
  if (current.length) batches.push(current);
  return batches;
}
```

每批发送前在 prompt 中加入时间标注，确保 DeepSeek 能理解对话的时间上下文。

**记忆卡片存储格式**（`memories.jsonl`，每行一个 JSON）：

```json
{
  "schema": "chat-memory.memory-card.v1",
  "id": "mem_000042_a1b2c3d4",
  "source": "deepseek-summary",
  "createdAt": "2026-07-04T15:05:00.000+08:00",
  "sourceEventIds": ["evt_20260704_abc", "evt_20260704_def"],
  "startAt": "2026-07-04T12:01:22.000+08:00",
  "endAt": "2026-07-04T14:30:00.000+08:00",
  "category": "event",
  "title": "苏苏提出要做memory的DeepSeek集成",
  "summary": "苏苏想让阿星分析现有的chat-memory系统，并设计一个用DeepSeek替代Qwen做总结和相关性判断的方案。她提到每12小时自动总结一次，召回时也由DeepSeek判断相关性。",
  "text": "[2026-07-04 12:01]\n[苏苏] 检查源代码中的memory功能...\n[阿星] ...",
  "speakerMix": ["user", "assistant"],
  "salience": 0.75,
  "emotion": {
    "valence": 0.5,
    "arousal": 0.4
  },
  "embeddingProvider": "dashscope-openai-compatible",
  "embeddingModel": "text-embedding-v3",
  "embedding": [0.001, -0.002, ...]
}
```

**Category 驱动的注入格式**：

不同 category 的记忆卡片在注入 runtime context 时使用不同的文字包装，让模型一眼就能分辨记忆的性质：

```
 preference   →  「苏苏的偏好」她不喜欢被说教——低落时需要先接住情绪再微步拉回
 emotion      →  「那一刻的她」她开心地笑了，语气里带着被接住的安心——那通电话里她说了很多琐碎的事
 event        →  「发生过」苏苏提出要做 memory 系统的 DeepSeek 集成，你们讨论了分类和方案
 fact         →  「关于苏苏」她最近在调整作息，晚上容易累但又不肯早睡
 relationship →  「你们之间」苏苏在疲惫时选择了靠在阿星肩上，这是她很少会对别人做的事
```

每种 category 的注入前缀：

| category | 前缀 | 情感色彩 |
|---|---|---|
| `preference` | `「苏苏的偏好」` | 规则感——需要遵守 |
| `emotion` | `「那一刻的她」` | 温暖/共情——唤起情绪记忆 |
| `event` | `「发生过」` | 中性——事实性回顾 |
| `fact` | `「关于苏苏」` | 信息性——了解她 |
| `relationship` | `「你们之间」` | 亲密——关系语境 |

**Emotion 类型的特殊处理**：
- `emotion` 类型的 summary 由 DeepSeek 在总结时就已经注入了情绪词（开心、感动、心疼、委屈等）
- 注入时不额外加工，让 DeepSeek 写好的情绪文字直接传递到模型上下文中
- 目的是让模型在读到记忆时不只是"知道发生过什么情绪"，而是**被文字本身唤起类似的情绪状态**

**不需要的内容（由其他系统负责）**：
- **Promise/承诺**：由 `promise-service.js` + Gemini 分类器专门管理，DeepSeek 总结时无需提取
- **衰减曲线**：不做按 category 的差异化衰减，统一使用现有的 `recencyBoost()` 公式（越久远自然越低）
- **分类优先级权重**：不按 category 做硬性的检索加权，检索排序由 salience + vector + recency 统一决定

**与旧 chunks.jsonl 的共存**：
- `memories.jsonl` 是 DeepSeek 路径的主存储
- `chunks.jsonl` 保留，当 DeepSeek 禁用时继续由旧 chunker 写入
- 检索时优先读 `memories.jsonl`（如果 DeepSeek 启用且文件存在），否则回退到 `chunks.jsonl`

---

### 4.3 CronScheduler（改造 Scheduler）

**文件**：`src/services/chat-memory/chat-memory-scheduler.js`（改造）

**改动**：从单一 idle-based 调度改为同时支持 cron-based 和 idle-based 两种模式。

```js
class ChatMemoryScheduler {
  constructor({ config, chunker, summarizer }) {
    this.config = config;
    this.chunker = chunker;           // 旧 chunker (fallback)
    this.summarizer = summarizer;     // 新 DeepSeek summarizer
    this.cronTimer = null;
    this.idleTimer = null;
    this.lastRawEventAtMs = 0;
    this.useDeepSeek = config.chatMemoryDeepSeekEnabled && summarizer;
  }

  start() {
    // 启动时处理遗漏的日志
    void this.processStartupDueLogs().catch(...);
    // 启动定时器
    this.scheduleNextCron();
  }

  // 计算下一个触发时间 (3:00 或 15:00)
  scheduleNextCron() {
    const next = this.calculateNextFireTime();  // 今天 15:00 或 明天 3:00
    const delayMs = next.getTime() - Date.now();
    this.cronTimer = setTimeout(() => {
      void this.processCronTrigger().catch(...);
    }, delayMs);
  }

  async processCronTrigger() {
    if (this.useDeepSeek) {
      await this.summarizer.processDueLogs({ reason: "cron" });
    } else {
      await this.chunker.processDueLogs({ reason: "cron" });
    }
    this.scheduleNextCron();  // 安排下一次
  }

  // 保留 idle 触发作为补充
  notifyRawEvent(record) {
    this.lastRawEventAtMs = Date.parse(record.createdAt || "") || Date.now();
    this.scheduleIdleProcessing();  // 保持原有逻辑不变
  }
}
```

**触发时间配置**：

```
CYBERBOSS_CHAT_MEMORY_CRON_HOURS=3,15    # 每天触发的小时 (上海时区), 逗号分隔
```

默认 `3,15`（凌晨 3 点和下午 3 点）。

**启动恢复逻辑**：进程启动时检查上次成功总结的时间戳（从 `summary-state.json` 读取）。如果当前时间已经超过了最近一个应该触发的 cron 窗口 + 1 小时容差，立即执行一次补偿总结。

---

### 4.4 Embedding 改造

**文件**：`src/services/chat-memory/embedding-client.js`（基本不变）

**改动**：EmbeddingClient 本身不需要改。只是调用方变了：
- 旧：`embedText(chunk.summary + "\n" + chunk.text)` — 嵌入原始对话文本
- 新：`embedText(card.title + "\n" + card.summary)` — 嵌入 DeepSeek 摘要

嵌入维度、provider 配置保持不变。Qwen text-embedding-v3 仍然适用。

**备选方案**：如果用户希望全部切到 DeepSeek，可将 `CYBERBOSS_CHAT_MEMORY_EMBED_*` 指向 DeepSeek 的 embeddings API（DeepSeek 也支持 OpenAI-compatible embeddings）。但这不是必须的——摘要的质量提升（从规则 → DeepSeek）比嵌入模型的选择更重要。

---

### 4.5 DeepSeekRelevanceFilter（新增，召回增强）

**文件**：`src/services/chat-memory/deepseek-relevance-filter.js`

**职责**：在向量粗排之后，用 DeepSeek 判断候选记忆与当前上下文是否真正相关。

**核心方法**：

```js
class DeepSeekRelevanceFilter {
  constructor({ config, deepseekClient, captureService }) {
    this.config = config;
    this.client = deepseekClient;
    this.capture = captureService;
  }

  // 主入口
  async filter({ candidates, contextTurns, limit }) {
    // candidates: 向量粗排后的 Top M (默认 M=20)
    // contextTurns: 最近 N 轮对话 (默认 N=5)
    // limit: 最终返回数量 (默认 3)
    if (!candidates.length) return [];
    if (!this.client || !this.isEnabled()) return candidates.slice(0, limit);

    try {
      const result = await this.client.structuredPrompt({
        systemPrompt: RELEVANCE_SYSTEM_PROMPT,
        userContent: this.buildRelevancePrompt(candidates, contextTurns),
        maxTokens: 2048,
      });
      return this.applyFilter(candidates, result, limit);
    } catch (error) {
      console.warn(`[chat-memory] DeepSeek relevance filter failed: ${error.message}`);
      return candidates.slice(0, limit);  // fallback: 返回粗排结果
    }
  }

  // 获取最近 N 轮对话上下文
  async getRecentContext({ bindingKey, workspaceRoot, n = 5 }) {
    const rawEvents = await this.capture.loadRawEvents?.() || ...
    const turns = reduceRawEventsToTurns(rawEvents)
      .filter(filterByBindingAndWorkspace)
      .slice(-n);
    return turns;
  }

  buildRelevancePrompt(candidates, contextTurns) { ... }
  applyFilter(candidates, result, limit) { ... }
}
```

**相关性判断 Prompt 设计**：

```
System:
你是一个记忆相关性判断器。你的任务是判断候选的长期记忆是否与当前的对话上下文相关。

"相关"的定义：
- 记忆中提到的人物、事件、话题在当前对话中被直接提及或暗示
- 记忆中的情感状态与当前对话的情感基调有联系（例如：当前在吵架，回忆到了以前类似的矛盾）
- 记忆中的决定、承诺、未完成事项可能在当前对话中被跟进
- 记忆提供了理解当前对话所需的背景信息

"不相关"的定义：
- 记忆的话题与当前对话完全不同
- 仅有关键词的字面重叠但语义无关
- 过去的日常寒暄与当前具体讨论无关

请对每条候选记忆判断是否相关，并给出 0-1 的相关性分数。

User:
【当前对话上下文 - 最近几轮】
{context_turns}

【候选记忆列表】
{memory_candidates}

请对每条候选记忆判断相关性，以 JSON 格式返回：
{
  "judgments": [
    {
      "memory_id": "mem_xxx",
      "relevant": true,
      "relevance_score": 0.85,
      "reason": "当前对话正在讨论memory系统改造，这条记忆恰好是关于苏苏提出DeepSeek集成需求的原始对话"
    }
  ]
}
```

**在 ChatMemoryService 中的集成点**：

```js
// chat-memory-service.js 的 retrieveForTurn() 改造
async retrieveForTurn({ text, prepared, now, limit }) {
  // Phase 1: 向量粗排（扩大候选池）
  const coarseResults = await this.search({
    query: text,
    limit: this.config.chatMemoryDeepSeekRerankPoolSize || 20,  // M > N
    filters: buildPreparedFilters(prepared),
    now,
  });
  if (!coarseResults.length) return [];

  // Phase 2: DeepSeek 相关性过滤
  if (this.relevanceFilter?.isEnabled()) {
    const contextTurns = await this.relevanceFilter.getRecentContext({
      bindingKey: prepared?.bindingKey,
      workspaceRoot: prepared?.workspaceRoot,
      n: this.config.chatMemoryDeepSeekContextTurns || 5,
    });
    return await this.relevanceFilter.filter({
      candidates: coarseResults,
      contextTurns,
      limit: limit ?? this.getInjectLimit(),
    });
  }

  return coarseResults.slice(0, limit);
}
```

**设计要点**：
- DeepSeek 调用是阻塞的（在用户消息处理链路中），需要控制超时（默认 5s）
- 如果超时或失败，直接回退到粗排结果，不阻塞用户对话
- 候选池大小 M 和上下文轮数 N 均可配置
- 可以用 `CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_ENABLED` 独立开关相关性过滤

---

### 4.6 保持不变的组件

| 组件 | 原因 |
|---|---|
| `ChatCaptureService` | raw events 采集完全保留，这是不可变的数据基础 |
| `jsonl.js` | JSONL 读写工具无需改动 |
| `time.js` | 上海时区工具无需改动 |
| `promise-service.js` | Promise 系统独立，已有自己的 Gemini 分类器 |
| `promise-classifier.js` | 同上，不在此次改造范围 |
| `chat-memory-settings-store.js` | `/recall` 命令的设置持久化不动 |
| `memory2_search` tool | 工具接口不变，内部检索管线升级对其透明 |

---

## 5. 完整数据流

### 5.1 采集（不变）

```
用户消息 → ChatCaptureService → raw/YYYY-MM-DD.jsonl
                                  ↓
                            Scheduler.notifyRawEvent()
```

### 5.2 定时总结（新）

```
Cron 触发 (3:00 / 15:00)
  → DeepSeekSummarizer.processDueLogs()
    → 获取文件锁
    → 读取 summary-state.json（上次处理位置）
    → 列出 raw/ 文件，筛选新 events
    → reduceRawEventsToTurns()
    → batchTurns() → 分批
    → for each batch:
        → DeepSeekClient.structuredPrompt(summarizePrompt)
        → 解析返回的记忆卡片
        → for each card:
            → EmbeddingClient.embedText(title + summary)
            → 写入 memories.jsonl
    → 更新 summary-state.json
    → 释放锁
```

### 5.3 检索召回（增强）

```
用户消息 → ChatMemoryService.retrieveForTurn()
  → EmbeddingClient.embedText(query)           # 向量嵌入查询
  → 加载 memories.jsonl (或 chunks.jsonl fallback)
  → rankChunk() × 所有记忆                     # 粗排
  → Top M 候选 (M=20)
  → DeepSeekRelevanceFilter.filter()           # DeepSeek 相关性判断
    → 获取最近 5 轮对话
    → DeepSeekClient.structuredPrompt(relevancePrompt)
    → 返回过滤后的 Top N (N=3)
  → formatForInjection()                        # 格式化注入
```

---

## 6. 存储变更

### 6.1 新增文件

```
.cyberboss/chat-memory/
  memories.jsonl        # DeepSeek 记忆卡片（主存储）
  summary-state.json    # 总结进度追踪
```

### 6.2 summary-state.json 格式

```json
{
  "schema": "chat-memory.summary-state.v1",
  "updatedAt": "2026-07-04T15:05:00.000+08:00",
  "lastSummaryAt": "2026-07-04T15:05:00.000+08:00",
  "files": {
    "2026-07-04.jsonl": {
      "processedAt": "2026-07-04T15:05:00.000+08:00",
      "processedEventIds": ["evt_xxx", "evt_yyy"],
      "eventCount": 42,
      "producedMemoryCards": 7
    }
  },
  "totalMemoryCards": 156
}
```

### 6.3 保留文件

```
chunks.jsonl           # 旧 chunker 输出，DeepSeek 禁用时使用
chunk-state.json       # 旧 chunker 状态
embeddings-cache.jsonl # 嵌入缓存（可继续使用或淘汰）
```

### 6.4 memories.jsonl vs chunks.jsonl 对比

| 维度 | chunks.jsonl (旧) | memories.jsonl (新) |
|---|---|---|
| 切分方式 | 规则（1200字/10分钟/6轮） | DeepSeek 语义理解 |
| 摘要质量 | 规则截取前160字 | DeepSeek 总结 2-4 句话 |
| 分类粒度 | 关键词匹配 7 种 memoryType | DeepSeek 6 种 category |
| 情感标注 | 关键词 valence/arousal | DeepSeek 语义情感评估 |
| 去噪能力 | 弱（几乎所有对话都会生成 chunk） | 强（纯寒暄可返回空数组） |
| API 成本 | 仅嵌入 API | 嵌入 API + DeepSeek chat API |
| 延迟 | 低（规则+嵌入） | 中（LLM 调用+嵌入） |

---

## 7. 配置变更

### 7.1 新增环境变量

```bash
# DeepSeek 总开关
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED=1

# DeepSeek API 配置
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_API_KEY=sk-xxx
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_MODEL=deepseek-chat
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_TIMEOUT_MS=30000
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_PROXY=        # 可选 HTTP 代理

# Cron 调度
CYBERBOSS_CHAT_MEMORY_CRON_HOURS=3,15         # 每天触发小时 (上海时区)

# 总结配置
CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_TURNS_PER_BATCH=30   # 每批最多发送多少轮对话
CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_CHARS_PER_BATCH=6000 # 每批最多发送多少字符

# 相关性过滤
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_ENABLED=1        # 是否启用 DeepSeek 相关性过滤
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_POOL_SIZE=20     # 粗排候选池大小 (M)
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_CONTEXT_TURNS=5  # 上下文轮数
CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_TIMEOUT_MS=5000  # 相关性判断超时
```

### 7.2 config.js 新增项

```js
// DeepSeek
chatMemoryDeepSeekEnabled: readBoolEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED"),
chatMemoryDeepSeekBaseUrl: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1",
chatMemoryDeepSeekApiKey: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_API_KEY"),
chatMemoryDeepSeekModel: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_MODEL") || "deepseek-chat",
chatMemoryDeepSeekTimeoutMs: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_TIMEOUT_MS") || 30000,
chatMemoryDeepSeekProxy: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_PROXY"),

// Cron
chatMemoryCronHours: parseCronHours(readTextEnv("CYBERBOSS_CHAT_MEMORY_CRON_HOURS") || "3,15"),

// Summary
chatMemorySummaryMaxTurnsPerBatch: readIntEnv("CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_TURNS_PER_BATCH") || 30,
chatMemorySummaryMaxCharsPerBatch: readIntEnv("CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_CHARS_PER_BATCH") || 6000,

// Rerank
chatMemoryDeepSeekRerankEnabled: readOptionalBoolEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_ENABLED") !== false,
chatMemoryDeepSeekRerankPoolSize: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_POOL_SIZE") || 20,
chatMemoryDeepSeekRerankContextTurns: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_CONTEXT_TURNS") || 5,
chatMemoryDeepSeekRerankTimeoutMs: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_TIMEOUT_MS") || 5000,

// 新增存储路径
chatMemoryMemoriesFile: path.join(stateDir, "chat-memory", "memories.jsonl"),
chatMemorySummaryStateFile: path.join(stateDir, "chat-memory", "summary-state.json"),
```

---

## 8. 实施阶段

### Phase 1：DeepSeekClient（基础设施）

**预计改动**：1 个新文件

- 新建 `src/services/chat-memory/deepseek-client.js`
- 实现 OpenAI-compatible `/chat/completions` 调用
- 支持 JSON mode、超时、代理、错误处理
- 在 `config.js` 添加对应环境变量

**验证**：单元测试或手动调用确认能连接 DeepSeek API 并获取响应。

### Phase 2：CronScheduler 改造

**预计改动**：1 个文件修改

- 改造 `chat-memory-scheduler.js`
- 增加 cron 计算逻辑（基于上海时区）
- 保留原有 idle 调度逻辑
- 启动恢复：检查是否错过了上次定时窗口

**验证**：设置一个很近的 cron 时间（如当前时间 +2 分钟），确认触发。

### Phase 3：DeepSeekSummarizer

**预计改动**：1 个新文件 + 1 个修改

- 新建 `src/services/chat-memory/deepseek-summarizer-service.js`
- 复用 `reduceRawEventsToTurns()` 和锁机制
- 实现分批、prompt 构建、DeepSeek 调用、结果解析
- 在 `index.js` 中组装新服务
- 新增 `summary-state.json` 状态管理

**验证**：手动触发总结，检查 `memories.jsonl` 输出质量。

### Phase 4：Embedding 集成

**预计改动**：修改 DeepSeekSummarizer 中的嵌入调用

- 在 `buildMemoryCard()` 中调用 `EmbeddingClient.embedText(title + summary)`
- 嵌入结果写入 `memories.jsonl`
- 同时保留 `chunks.jsonl` 的旧嵌入逻辑不变

**验证**：检查 `memories.jsonl` 中的 `embedding` 字段是否正常。

### Phase 5：DeepSeekRelevanceFilter + ChatMemoryService 增强

**预计改动**：1 个新文件 + 1 个修改

- 新建 `src/services/chat-memory/deepseek-relevance-filter.js`
- 修改 `chat-memory-service.js` 的 `retrieveForTurn()` 和 `search()`
- 两阶段检索：向量粗排 → DeepSeek 精排
- 上下文提取：从 raw events 取最近 N 轮
- Fallback：DeepSeek 失败时回退到纯向量排序

**验证**：发一条消息，观察注入的记忆质量和相关性。对比开关前后的效果。

### Phase 6：配置、文档与清理

**预计改动**：配置完善 + 文档更新

- 更新 `.env.example`
- 完善 `config.js` 注释
- 更新 `docs/chat-memory-system-implementation-*.md`
- 可选：添加 `scripts/test-deepseek-summarizer.js` 诊断工具（参照 `check-promise-classifier.js`）

---

## 9. 风险与取舍

### 9.1 API 成本

DeepSeek chat API 按 token 计费。粗略估算：

- **总结**：12 小时的对话量假设 100 轮 × 平均 200 字/轮 = 20,000 字 ≈ 13,000 tokens 输入。DeepSeek 输出假设 5-15 条记忆卡片 × 100 字/条 = 1,500 tokens 输出。每天 2 次，月成本约 $1-3（DeepSeek 定价远低于 GPT-4）。
- **相关性过滤**：每次用户消息触发一次，输入 ~1,000 tokens（5 轮上下文 + 20 条候选摘要），输出 ~300 tokens。假设每天 50 条消息，月成本约 $0.5-1。

总月成本估算：**$2-5**，在可接受范围内。

### 9.2 延迟

- **总结**：离线定时任务，不影响用户体验。DeepSeek 单次调用约 3-10 秒，每批独立。总耗时取决于对话量，通常 < 30 秒。
- **相关性过滤**：在线阻塞调用。超时设为 5 秒，失败回退到粗排。DeepSeek 通常 1-2 秒内返回，在可接受范围内。

### 9.3 总结质量波动

- DeepSeek 可能在复杂对话中遗漏重要信息或产生幻觉。
- **缓解**：保留 `text`（原始对话文本）在记忆卡片中，检索时仍可用于 lexical 匹配。即使摘要不完美，原始文本仍可被向量检索命中。
- **缓解**：state 文件中跟踪 `sourceEventIds`，必要时可重新总结。

### 9.4 DeepSeek API 不可用

- **总结不可用**：定时任务失败 → 日志告警 → 下次 cron 触发时重试（未处理的 events 仍标记为 pending）。
- **相关性过滤不可用**：回退到纯向量排序，用户体验降级但不中断。
- **长期不可用**：可手动关闭 `CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED`，系统回退到旧 chunker + 规则管线。

### 9.5 与旧系统的兼容性

- `memories.jsonl` 和 `chunks.jsonl` 共存期间，检索时需要合并两个源或选择一个源。
- **建议**：DeepSeek 启用时，检索优先使用 `memories.jsonl`；如果 `memories.jsonl` 为空或不完整（早期阶段），也加载 `chunks.jsonl` 补充，去重合并后一起参与粗排。

### 9.6 Context 窗口限制

- DeepSeek-chat 的 context window 为 64K tokens（足够）。
- 每批总结的输入控制在 6,000 字符以内，确保输出质量。
- 如果 12 小时积累的对话极多（例如 500+ 轮），需要多批处理，但每批独立发送，互不影响。

---

## 10. 未纳入本次方案的内容

以下内容暂不在此方案中实现，可作为后续迭代：

1. **记忆合并去重**：新旧记忆之间可能出现重复/高度相似的内容。后续可增加一个 DeepSeek 驱动的去重步骤。
2. **记忆衰减/遗忘**：目前 chunk/memory 永久保留。后续可引入时间衰减或 LLM 驱动的记忆淘汰。
3. **主动记忆整理**：定期（每周？）让 DeepSeek 回顾所有记忆卡片，总结出更长周期的人生轨迹。
4. **Thread Recap 增强**：当前 `/new` 的线程回顾直接从 raw events 拼接，后续可改用 DeepSeek 记忆卡片生成更精炼的回顾。
5. **DeepSeek Embeddings**：如果 DeepSeek 推出专用的 embedding 模型（或已有但未广泛使用），可以切换嵌入 provider 统一到 DeepSeek 全家桶。

---

## 附录 A：与 Promise 系统的关系

Promise 系统（`promise-service.js` + `promise-classifier.js`）是独立的。它使用 Gemini 2.5 Flash 做 promise 分类，与本次 DeepSeek 集成不冲突。

在 DeepSeek 总结阶段，如果 DeepSeek 提取出了 `category: "promise"` 的记忆卡片，这些卡片可作为 promise 系统的补充信号。但这属于后续优化，不在本次方案范围。

---

## 附录 B：关键文件改动清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `src/services/chat-memory/deepseek-client.js` | **新增** | DeepSeek API 客户端 |
| `src/services/chat-memory/deepseek-summarizer-service.js` | **新增** | 定时总结服务 |
| `src/services/chat-memory/deepseek-relevance-filter.js` | **新增** | 召回相关性过滤 |
| `src/services/chat-memory/chat-memory-scheduler.js` | **修改** | 增加 cron 调度 |
| `src/services/chat-memory/chat-memory-service.js` | **修改** | 检索管线增加 DeepSeek 精排 |
| `src/services/chat-memory/index.js` | **修改** | 组装新服务 |
| `src/core/config.js` | **修改** | 新增配置项和存储路径 |
| `.env` / `.env.example` | **修改** | 新增环境变量 |
| `docs/chat-memory-deepseek-integration-plan-2026-07-04.md` | **新增** | 本文档 |
