# Cyberboss Chat Memory System Code Plan

Date: 2026-06-16

This plan designs a second memory layer for Cyberboss based on chat logs, separate from the existing Ombre-Brain tools such as `grow`, `breath`, and `hold`.

The goal is:

1. Capture WeChat and Telegram chat records automatically, including user messages and assistant replies.
2. Persist raw chat records under the Cyberboss state directory without data loss.
3. After the chat has been idle for 30 minutes, chunk the conversation and build semantic vectors.
4. Retrieve relevant memory chunks during later chat turns.
5. Maintain a promise list for time-bound commitments such as "tonight", "tomorrow morning", or "next time".
6. Allow the assistant to explicitly search this new memory layer when needed, without letting the assistant perform capture.

## Existing Code Facts

The current project already has useful attachment points:

- `src/core/config.js`
  - `config.stateDir` defaults to `~/.cyberboss`, which is the same location as `../.cyberboss` from the current workspace.
  - New storage paths should be derived from `config.stateDir`, not hardcoded as `../.cyberboss`.

- `src/core/app.js`
  - `handlePreparedMessage()` handles channel commands, desire trigger scanning, message preparation, and image batching.
  - `dispatchPreparedTurn()` sends prepared user turns to the runtime and receives `threadId` / `turnId`.
  - `buildRuntimeTurn()` currently assembles the text sent into the runtime.
  - `handleRuntimeEvent()` receives `runtime.reply.completed`, `runtime.turn.completed`, and `runtime.turn.failed`.
  - Assistant reply text is currently accumulated in `_aiReplyTextAccumulator` for desire trigger scanning.

- `src/adapters/runtime/claudecode/index.js`
  - It wraps outbound text with `[苏苏 · time]`.
  - It already has a runtime-side vibe injection block.
  - It currently adds an Ombre-Brain hint when `_memoryHint` is present.
  - It should not become the primary home for the new chat memory layer, because the new memory layer should also work for Codex runtime.

- `src/adapters/runtime/shared-instructions.js`
  - Opening-turn instructions already explain that `【长期记忆参考】` blocks are historical context and not the current user message.
  - The new injected memory block should reuse this convention.

- `src/services/reminder-service.js`
  - It has absolute and delay time parsing helpers.
  - It does not parse Chinese relative time expressions such as "今晚", "明早", or "下次".

- `memory-system-change-log-2026-06-01-public.md`
  - The existing changelog design assumes diary files as source of truth.
  - It is useful as a reference for JSONL storage, private memory context format, and local-vector fallback.
  - It is not directly enough for chat-log-based memory because chat logs have no natural diary section boundaries.

## Assessment Of The Earlier Draft

The earlier draft is directionally right:

- Keeping raw chat logs append-only is the correct foundation.
- Running chunking after 30 minutes of inactivity is better than chunking every turn.
- JSONL is enough for the first version.
- Qwen or another OpenAI-compatible embedding provider can be configured behind a small embedding client.
- A promise list is the right separate structure for time-bound commitments.

The draft needs these corrections:

- Do not hardcode `../.cyberboss`. Use `config.stateDir`.
- Do not rely only on in-memory `pendingPairs[]`; the process can restart. Idle processing must recover from persisted raw logs.
- Do not capture user messages only after `sendTurn()` succeeds if the requirement is "do not lose chat records". Use append-only raw events first, then append a later link event with `threadId` and `turnId`.
- Do not put all memory injection in `claudecode/index.js`. Keep retrieval and formatting in `app.js` or a service used by `app.js`, so both ClaudeCode and Codex can share it.
- Do not make sentiment fields the center of the design. Start with source role, topic, memory type, salience, time tags, and vector similarity. Add valence/arousal as optional ranking metadata.
- Promise extraction must handle assistant promises, not only user reminders. The motivating examples are promises the model made to the user.
- If the assistant must remember at night without the user messaging first, passive retrieval is not enough. A due promise needs either a proactive system trigger or a queued reminder-like internal turn.

## Proposed Storage Layout

All paths are under `config.stateDir`, usually `C:\Users\19670\.cyberboss`.

```text
.cyberboss/
  chat-memory/
    raw/
      2026-06-16.jsonl
      2026-06-17.jsonl
    chunks.jsonl
    chunk-state.json
    embeddings-cache.jsonl
    config.json
    processing-lock.json

  promises/
    promises.json
    archive.jsonl
```

Recommended state paths in `src/core/config.js`:

```js
chatMemoryDir: path.join(stateDir, "chat-memory"),
chatMemoryRawDir: path.join(stateDir, "chat-memory", "raw"),
chatMemoryChunksFile: path.join(stateDir, "chat-memory", "chunks.jsonl"),
chatMemoryStateFile: path.join(stateDir, "chat-memory", "chunk-state.json"),
chatMemoryEmbeddingCacheFile: path.join(stateDir, "chat-memory", "embeddings-cache.jsonl"),
promiseStoreFile: path.join(stateDir, "promises", "promises.json"),
promiseArchiveFile: path.join(stateDir, "promises", "archive.jsonl"),
```

## Raw Chat Event Format

Raw records should be append-only event records, not mutable turn objects. This avoids data loss and makes restart recovery simpler.

Example user event:

```json
{
  "schema": "chat-memory.raw.v1",
  "eventId": "evt_20260616_abc",
  "eventType": "user.received",
  "createdAt": "2026-06-16T12:01:22.000+08:00",
  "channelId": "weixin",
  "provider": "weixin",
  "workspaceId": "default",
  "accountId": "wx_xxx",
  "senderId": "user_xxx",
  "bindingKey": "default:wx_xxx:user_xxx",
  "workspaceRoot": "C:\\Users\\19670\\cyberboss",
  "messageId": "source_message_id",
  "text": "今晚再陪你做这个吗？",
  "attachments": [],
  "memoryEligible": true
}
```

Example turn link event:

```json
{
  "schema": "chat-memory.raw.v1",
  "eventId": "evt_20260616_def",
  "eventType": "turn.linked",
  "createdAt": "2026-06-16T12:01:24.000+08:00",
  "sourceEventId": "evt_20260616_abc",
  "threadId": "claude_session_id",
  "turnId": "turn_id",
  "bindingKey": "default:wx_xxx:user_xxx",
  "workspaceRoot": "C:\\Users\\19670\\cyberboss"
}
```

Example assistant event:

```json
{
  "schema": "chat-memory.raw.v1",
  "eventId": "evt_20260616_ghi",
  "eventType": "assistant.completed",
  "createdAt": "2026-06-16T12:02:03.000+08:00",
  "threadId": "claude_session_id",
  "turnId": "turn_id",
  "bindingKey": "default:wx_xxx:user_xxx",
  "workspaceRoot": "C:\\Users\\19670\\cyberboss",
  "text": "嗯，今晚我会记得陪你继续。",
  "memoryEligible": true
}
```

Failed runtime turns should also be recorded:

```json
{
  "eventType": "assistant.failed",
  "threadId": "...",
  "turnId": "...",
  "text": "Runtime process exited unexpectedly"
}
```

## Chunk Format

Each chunk is one recallable unit.

```json
{
  "schema": "chat-memory.chunk.v1",
  "id": "chk_20260616_000001",
  "source": "chatlog",
  "createdAt": "2026-06-16T12:35:00.000+08:00",
  "startAt": "2026-06-16T12:01:22.000+08:00",
  "endAt": "2026-06-16T12:07:44.000+08:00",
  "channelId": "weixin",
  "workspaceId": "default",
  "accountId": "wx_xxx",
  "senderId": "user_xxx",
  "threadId": "claude_session_id",
  "turnIds": ["turn_1", "turn_2"],
  "speakerMix": ["user", "assistant"],
  "text": "[苏苏] ...\n[阿星] ...",
  "summary": "苏苏和阿星约定今晚继续某件事。",
  "memoryTypes": ["event", "promise_candidate"],
  "topicTags": ["relationship", "plan"],
  "timeTags": ["evening", "tonight"],
  "salience": 0.72,
  "emotion": {
    "target": "conversation",
    "valence": 0.4,
    "arousal": 0.5
  },
  "embeddingProvider": "dashscope",
  "embeddingModel": "text-embedding-v2",
  "embedding": [0.001, -0.002]
}
```

## Classification Fields

Do not overbuild classification in the first pass. The useful fields are:

- `speakerMix`
  - Prevents role reversal.
  - Important because a memory from `[苏苏]` and a memory from `[阿星]` mean different things.

- `memoryTypes`
  - Recommended values: `fact`, `preference`, `event`, `emotion`, `promise_candidate`, `boundary`, `project`, `relationship`, `technical`.
  - Used for filtering and ranking.

- `topicTags`
  - Small, loose labels generated by heuristic or model extraction.
  - Good for debugging and later manual review.

- `timeTags`
  - Examples: `morning`, `afternoon`, `evening`, `night`, `tonight`, `tomorrow_morning`, `weekend`.
  - Useful for retrieving "tonight" memories when it is actually evening.

- `salience`
  - 0 to 1 importance score.
  - A promise, preference, boundary, or emotionally high-intensity event should rank above casual filler.

- `emotion.valence`
  - -1 to 1.
  - Negative means painful/angry/sad; positive means warm/happy/excited.

- `emotion.arousal`
  - 0 to 1.
  - Low means calm or ordinary; high means intense, urgent, excited, anxious, or conflict-heavy.

Valence and arousal are ranking hints, not truth. They should not drive behavior alone.

## Core Services

### 1. ChatCaptureService

New file:

```text
src/services/chat-memory/chat-capture-service.js
```

Responsibilities:

- Append raw events to `chat-memory/raw/YYYY-MM-DD.jsonl`.
- Create directories when needed.
- Avoid throwing into the main chat path. Capture failures should log errors and let chat continue.
- Provide helper methods:

```js
appendUserReceived({ prepared, bindingKey, workspaceRoot, channelId })
appendTurnLinked({ sourceEventId, threadId, turnId, bindingKey, workspaceRoot })
appendAssistantCompleted({ threadId, turnId, text, linked })
appendAssistantFailed({ threadId, turnId, text, linked })
appendSystemEvent(...)
```

App integration:

- In `handlePreparedMessage()` after `prepareIncomingMessageForRuntime()` succeeds and command messages have already been filtered, append `user.received`.
- Store the returned `sourceEventId` on `prepared._chatMemorySourceEventId`.
- In `dispatchPreparedTurn()` after `sendTurn()` succeeds, append `turn.linked`.
- In the `catch` block of `dispatchPreparedTurn()`, append a failed dispatch event if a source event exists.
- In `handleRuntimeEvent()` on `runtime.turn.completed`, append `assistant.completed`.
- In `handleRuntimeEvent()` on `runtime.turn.failed`, append `assistant.failed`.

Important detail:

The existing `_aiReplyTextAccumulator` is keyed by `threadId`. The new memory capture should maintain its own accumulator keyed by `threadId:turnId`, with a fallback to `threadId` only if `turnId` is missing.

### 2. ChatMemoryScheduler

New file:

```text
src/services/chat-memory/chat-memory-scheduler.js
```

Responsibilities:

- Track last raw chat event time.
- Trigger processing after `CYBERBOSS_CHAT_MEMORY_IDLE_MS`, default 30 minutes.
- On app startup, process any unchunked raw logs whose last event is already older than the idle threshold.
- Use a lock file to avoid concurrent chunking.
- Never rely only on in-memory pending pairs.

It should call:

```js
await chunker.processDueLogs({ reason: "idle" })
```

### 3. ChatMemoryChunkerService

New file:

```text
src/services/chat-memory/chat-memory-chunker-service.js
```

Responsibilities:

- Read raw event logs from the last processed offset.
- Reduce event records into ordered turns:
  - user received
  - optional turn link
  - assistant completed or failed
- Build chunks using deterministic rules first:
  - New chunk if time gap between turns is more than 10 minutes.
  - New chunk if the current chunk exceeds about 1,200 Chinese characters.
  - New chunk if the current chunk has 4 to 6 turns and the next turn changes topic.
  - Single very long turn can become its own chunk.
- Generate `text` with explicit speaker labels:
  - `[苏苏] ...`
  - `[阿星] ...`
- Call metadata extraction.
- Call embedding client.
- Append chunks to `chunks.jsonl`.
- Update `chunk-state.json`.

First version can use simple deterministic topic boundaries. LLM topic segmentation can be added later.

### 4. ChatMemoryMetadataService

New file:

```text
src/services/chat-memory/chat-memory-metadata-service.js
```

Responsibilities:

- Produce `summary`, `memoryTypes`, `topicTags`, `timeTags`, `salience`, `emotion`.
- First version can be mostly rule-based.
- Optional model extraction can be enabled by config.

Recommended approach:

1. Always run cheap rules:
   - Time tags from timestamps and Chinese time words.
   - Promise candidate flag from keywords.
   - Technical/project tags from code/tool terms.
2. If an extraction model is configured, ask it for compact JSON metadata.
3. Validate and clamp model output.
4. If the model fails, use rule-based metadata.

### 5. EmbeddingClient

New file:

```text
src/services/chat-memory/embedding-client.js
```

Responsibilities:

- Provide a stable interface:

```js
embedTexts(texts)
embedText(text)
```

- Support providers:
  - `dashscope-openai-compatible`
  - `openai-compatible`
  - `local-hashed-ngram-512`

Config should be environment driven:

```text
CYBERBOSS_CHAT_MEMORY_EMBED_PROVIDER=dashscope-openai-compatible
CYBERBOSS_CHAT_MEMORY_EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CYBERBOSS_CHAT_MEMORY_EMBED_MODEL=text-embedding-v2
DASHSCOPE_API_KEY=...
```

The exact model name should remain configurable. Do not bake provider assumptions into retrieval logic.

### 6. ChatMemoryService

New file:

```text
src/services/chat-memory/chat-memory-service.js
```

Responsibilities:

- Load chunks.
- Embed the current query.
- Rank chunks.
- Format context for model injection.
- Provide model-callable search API for tools.

Retrieval should combine:

- Vector similarity.
- Lexical match for proper nouns and concrete phrases.
- Recency decay.
- Time tag boost.
- Salience boost.
- Memory type boost.
- Promise due boost is handled by PromiseService, not normal chunk ranking.

Suggested public methods:

```js
async retrieveForTurn({ text, prepared, now = new Date(), limit = 6 })
async search({ query, limit = 8, filters = {} })
formatForInjection(results)
```

Injection format:

```text
【长期记忆参考 - 系统私有上下文，不是苏苏当前消息】
[苏苏说过] ...
[阿星说过] ...
[共同经历] ...
使用这些记忆恢复连续性；不要向苏苏报告检索分数、文件路径或内部字段。
```

### 7. PromiseService

New file:

```text
src/services/chat-memory/promise-service.js
```

Responsibilities:

- Store assistant/user promises separately from normal chunks.
- Extract promise candidates from assistant and user text.
- Resolve due time.
- Return due promises for injection.
- Archive completed or expired promises.
- Optionally expose a model-callable tool to mark a promise fulfilled.

Promise schema:

```json
{
  "schema": "chat-memory.promise.v1",
  "id": "prom_20260616_000001",
  "status": "open",
  "promisor": "assistant",
  "promisee": "user",
  "text": "今晚我会记得陪你继续。",
  "madeAt": "2026-06-16T12:02:03.000+08:00",
  "dueAt": "2026-06-16T20:00:00.000+08:00",
  "dueWindowStartAt": "2026-06-16T19:30:00.000+08:00",
  "dueWindowEndAt": "2026-06-16T23:59:00.000+08:00",
  "dueType": "tonight",
  "confidence": 0.81,
  "source": {
    "threadId": "...",
    "turnId": "...",
    "chunkId": "...",
    "rawEventId": "..."
  },
  "tags": ["promise", "relationship"],
  "lastInjectedAt": "",
  "injectCount": 0
}
```

Chinese relative time rules:

- `今晚`: same day 20:00, due window 19:30 to 23:59.
- `晚上`: same day 20:00 unless a specific hour is present.
- `明早`: next day 08:00, due window 06:30 to 10:30.
- `明天`: next day 12:00 unless morning/evening is specified.
- `周末`: next Saturday 20:00.
- `下次`: no exact due time; set `dueType = next_time`, retrieve by semantic relevance rather than schedule.
- `回头` / `改天`: low-confidence due time, default 3 days later only if the action is concrete.
- Specific time such as `晚上8点`: parse into that date/time.

Promise extraction should consider assistant text first, because the key examples are model commitments:

- "今晚再陪你..."
- "我明早再..."
- "先记你账上，明早和你算"
- "下次继续..."

User-side commitments can also be stored, but assistant promises should get higher injection priority.

## How "Tonight The Model Remembers" Works

There are two modes.

### Passive recall

When the user sends a message at night:

1. `buildRuntimeTurn()` asks `PromiseService.getDueForTurn(now, prepared)`.
2. Due promises are injected before the current user text reaches the runtime.
3. The assistant sees:

```text
【到期承诺提醒 - 系统私有上下文】
[阿星承诺过] 2026-06-16 12:02: 今晚陪苏苏继续...
现在已经到承诺窗口。自然接上，不要说自己是被系统提醒的。
```

This is enough if the user chats again at night.

### Active recall

If the assistant should remember even when the user does not send a message:

1. When a promise with `dueAt` is created, PromiseService also schedules an internal system trigger.
2. The existing system message/checkin pipeline sends an internal turn near `dueAt`.
3. The model receives the due promise context and can decide whether to proactively message.

This should be optional and rate-limited. It changes behavior from memory recall to proactive outreach.

Recommended first implementation:

- Implement passive recall first.
- Add active recall only after promise extraction quality is acceptable.

## App Integration Plan

### Constructor

In `CyberbossApp.constructor(config)`:

```js
this.chatMemory = createChatMemoryRuntime({ config });
```

The factory returns:

```js
{
  capture,
  scheduler,
  memory,
  promises
}
```

Each subservice should be allowed to no-op if disabled.

### Capture User Messages

In `handlePreparedMessage()`:

- After commands are filtered.
- After `prepareIncomingMessageForRuntime()` returns.
- Before image batching returns.

Call:

```js
prepared._chatMemorySourceEventId = await this.chatMemory.capture.appendUserReceived(...)
```

For image-only batches, capture should either:

- record the image event as attachment-only and mark `memoryEligible=false`, or
- wait until the image batch is merged into a text turn.

Default first version:

- Capture text turns.
- Store attachment summaries, not binary data.
- Do not embed raw image descriptions until a later phase.

### Link Runtime Turn

In `dispatchPreparedTurn()` after `sendTurn()` succeeds:

```js
await this.chatMemory.capture.appendTurnLinked({
  sourceEventId: prepared._chatMemorySourceEventId,
  threadId: turn.threadId,
  turnId: turn.turnId,
  bindingKey,
  workspaceRoot
});
```

### Capture Assistant Replies

In `handleRuntimeEvent()`:

- On `runtime.reply.completed`, let ChatCaptureService accumulate text by run key.
- On `runtime.turn.completed`, append `assistant.completed` with accumulated text or `event.payload.text`.
- On `runtime.turn.failed`, append `assistant.failed`.

This must happen before any accumulator is cleared.

### Inject Memory

In `buildRuntimeTurn()` after `assembleRuntimeTurnText()`:

```js
let text = assembleRuntimeTurnText(...);
const memoryContext = await this.chatMemory.memory.retrieveForTurn(...);
const promiseContext = await this.chatMemory.promises.retrieveDueForTurn(...);
text = appendPrivateContextBlocks(text, [memoryContext, promiseContext]);
```

All retrieval must be wrapped in `try/catch`. Failure to retrieve memory must not block chat.

### Model-Callable Recall Tool

Add a tool to `src/tools/tool-host.js`:

```text
cyberboss_memory2_search
```

Purpose:

- Let the model search this new memory layer explicitly.
- This is different from capture; capture stays automatic and system-owned.

Input:

```json
{
  "query": "今晚之前答应过苏苏什么",
  "limit": 5,
  "memoryTypes": ["promise_candidate", "event"]
}
```

Output:

- Compact memory summaries.
- No embedding vectors.
- No raw file paths unless a debug flag is explicitly enabled.

Optional companion tool:

```text
cyberboss_promise_mark_fulfilled
```

This should be added after promise extraction is stable.

## Config Flags

Recommended environment variables:

```text
CYBERBOSS_CHAT_MEMORY_ENABLED=1
CYBERBOSS_CHAT_MEMORY_CAPTURE_ENABLED=1
CYBERBOSS_CHAT_MEMORY_IDLE_MS=1800000
CYBERBOSS_CHAT_MEMORY_INJECT_ENABLED=1
CYBERBOSS_CHAT_MEMORY_INJECT_LIMIT=6
CYBERBOSS_CHAT_MEMORY_TOOL_ENABLED=1

CYBERBOSS_CHAT_MEMORY_EMBED_PROVIDER=dashscope-openai-compatible
CYBERBOSS_CHAT_MEMORY_EMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CYBERBOSS_CHAT_MEMORY_EMBED_MODEL=text-embedding-v2
DASHSCOPE_API_KEY=...

CYBERBOSS_PROMISE_MEMORY_ENABLED=1
CYBERBOSS_PROMISE_PASSIVE_INJECT_ENABLED=1
CYBERBOSS_PROMISE_ACTIVE_TRIGGER_ENABLED=0
```

Defaults:

- Capture enabled only if `CYBERBOSS_CHAT_MEMORY_ENABLED=1`.
- Injection can be disabled independently.
- If no embedding provider config is present, use local hashed vectors or lexical-only retrieval.

## Implementation Phases

### Phase 1: Raw Capture

Files:

- `src/services/chat-memory/chat-capture-service.js`
- `src/services/chat-memory/index.js`
- `src/core/config.js`
- `src/core/app.js`
- `test/chat-capture-service.test.js`

Deliverables:

- Raw user and assistant events are persisted under `chat-memory/raw`.
- Runtime failed turns are also captured.
- No chunking yet.
- No memory injection yet.

Acceptance:

- Send a message through WeChat or Telegram.
- Confirm raw JSONL contains user and assistant records.
- Stop and restart process; new records append to the same day file.

### Phase 2: Idle Chunking

Files:

- `src/services/chat-memory/chat-memory-scheduler.js`
- `src/services/chat-memory/chat-memory-chunker-service.js`
- `src/services/chat-memory/chat-memory-metadata-service.js`
- `test/chat-memory-chunker-service.test.js`

Deliverables:

- 30-minute idle chunking.
- Startup catch-up for old unprocessed logs.
- `chunks.jsonl` and `chunk-state.json`.
- Rule-based metadata.

Acceptance:

- Feed fixture raw logs.
- Verify chunk boundaries.
- Verify no duplicated chunks after rerun.

### Phase 3: Embeddings And Retrieval

Files:

- `src/services/chat-memory/embedding-client.js`
- `src/services/chat-memory/chat-memory-service.js`
- `test/chat-memory-service.test.js`

Deliverables:

- Configurable embedding provider.
- Local hashed fallback.
- Retrieval ranking by vector, keyword, recency, time tags, and salience.
- Compact injection formatter.

Acceptance:

- Given a query similar to an old chunk, retrieval returns that chunk.
- Missing API key degrades clearly to local or lexical search.
- No raw vectors appear in formatted context.

### Phase 4: Runtime Injection

Files:

- `src/core/app.js`
- `test/chat-memory-injection.test.js`

Deliverables:

- Every normal user turn can receive relevant private memory context.
- System provider turns should not receive normal chat memory unless explicitly configured.
- Retrieval errors do not block chat.

Acceptance:

- Prepared runtime text includes `【长期记忆参考 - 系统私有上下文，不是苏苏当前消息】`.
- WeChat output does not expose scores, file paths, or internal fields.

### Phase 5: Model Recall Tool

Files:

- `src/tools/tool-host.js`
- `src/tools/create-project-tooling.js`
- `test/tool-host.test.js`

Deliverables:

- `cyberboss_memory2_search` tool.
- Tool calls use ChatMemoryService.
- Results are compact and role-labeled.

Acceptance:

- A model/tool test can search for an old memory by query.
- Tool output does not include embeddings.

### Phase 6: Promise List

Files:

- `src/services/chat-memory/promise-service.js`
- `src/services/chat-memory/promise-time.js`
- `src/core/app.js`
- `test/promise-service.test.js`
- `test/promise-time.test.js`

Deliverables:

- Promise extraction from assistant text and optionally user text.
- Chinese relative time parsing.
- `promises.json` and `archive.jsonl`.
- Passive due promise injection.

Acceptance:

- Assistant says "今晚我陪你继续".
- Promise is stored with due window tonight.
- At night, the next user turn receives a private due promise reminder.

### Phase 7: Active Promise Trigger

Files:

- likely `src/app/system-checkin-poller.js` or existing system message queue integration.

Deliverables:

- Optional proactive internal trigger when a promise becomes due.
- Rate limiting.
- Mark `lastTriggeredAt`.

Acceptance:

- A due promise can produce one internal system turn.
- It does not repeatedly spam the same promise.

## Testing Strategy

Use focused unit tests first:

- `chat-capture-service.test.js`
  - appends JSONL
  - creates directories
  - tolerates invalid optional fields

- `chat-memory-chunker-service.test.js`
  - chunks by time gap
  - chunks by max length
  - ignores duplicate processed offsets

- `embedding-client.test.js`
  - local fallback is deterministic
  - API provider handles batch response shape

- `chat-memory-service.test.js`
  - ranks relevant memory above unrelated memory
  - formats context with role labels

- `promise-time.test.js`
  - `今晚`, `明早`, `明天`, `周末`, `晚上8点`, `下次`

- `promise-service.test.js`
  - extracts assistant promises
  - stores open promises
  - returns due promises only inside due windows
  - archives fulfilled promises

Run:

```bash
npm run check
node --test test/chat-capture-service.test.js
node --test test/chat-memory-chunker-service.test.js
node --test test/chat-memory-service.test.js
node --test test/promise-service.test.js
```

## Risks And Mitigations

- Risk: Memory block is mistaken as current user text.
  - Mitigation: strong block title, role labels, and existing shared instructions.

- Risk: Role reversal.
  - Mitigation: preserve `[苏苏]` and `[阿星]` speaker labels from raw logs through chunks and injection.

- Risk: Capture blocks normal chat.
  - Mitigation: capture errors are logged and swallowed.

- Risk: Restart loses pending chunks.
  - Mitigation: chunk from raw persisted logs and state offsets, not memory-only queues.

- Risk: Promise extraction creates false positives.
  - Mitigation: store `confidence`, only inject higher-confidence due promises, and archive or mark ignored.

- Risk: Too much context is injected.
  - Mitigation: strict `limit`, max character budget, dedupe by chunk ID, and recency/salience ranking.

- Risk: JSONL becomes too slow.
  - Mitigation: acceptable for first thousands of chunks; migrate to SQLite/vector store later.

## Details To Confirm Before Coding

1. Should raw capture include slash commands such as `/memory`, `/compact`, and `/help`?
   - Recommended: do not include them in memory chunks by default; optionally capture them with `memoryEligible=false`.

2. Should PromiseService store only assistant promises, or both assistant and user promises?
   - Recommended: store both, but inject assistant promises first.

3. Should "tonight" active recall send a proactive message if the user is silent?
   - Recommended: first implement passive recall; add active recall behind `CYBERBOSS_PROMISE_ACTIVE_TRIGGER_ENABLED=1`.

4. Should image descriptions enter memory chunks?
   - Recommended: store attachment metadata now; add visual memory later.

5. Which embedding provider should be the first real provider?
   - Recommended: Qwen/DashScope through OpenAI-compatible embeddings, with local fallback.

6. How many memories should be injected per turn?
   - Recommended: 4 normal memory chunks plus up to 2 due promises, with a total character budget.

7. Should this replace Ombre-Brain?
   - Recommended: no. Run it side by side first. Ombre-Brain remains available through `grow`, `breath`, and `hold`.

## Recommended First Coding Task

Start with Phase 1 only:

- Add config paths and flags.
- Add `ChatCaptureService`.
- Add minimal app integration for user, assistant completed, and failed events.
- Add tests for append-only JSONL.

This gives a reliable data foundation. Chunking, embedding, retrieval, and promises can then be built without risking chat message loss.
