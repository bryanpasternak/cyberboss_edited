# Telegram 增量封口发送实现方案

> 日期：2026-08-30  
> 状态：第一版已实施，默认关闭  
> 范围：Cyberboss 的普通 Telegram 文本回复；第一版不改变微信、QQ、system reply 或自审语义

## 背景

Cyberboss 已经能够从 Codex 收到 `runtime.reply.delta`。当前 `StreamDelivery` 会把 delta 累积在回复项的 `currentText` 中，但不会在 delta 到达时发送；只有收到 `runtime.reply.completed` 或 `runtime.turn.completed` 后才调用 `flush`。Telegram adapter 随后再把完整文本切成若干条消息。

因此，终端可以持续显示模型输出，而 Telegram 仍要等一个回复项或整轮完成才开始收到正文。现有 `/chunk` 只控制完整回复完成后的短段合并，不能改变首次送达时间。

## 目标

为 Telegram 增加“增量封口发送”能力：

1. 模型仍在生成时，未发送正文达到一条 Telegram 消息的安全容量后，立即封口并发送一段；
2. 已成功发送的段落不再撤回或重写；
3. 模型完成后发送不足一条的尾部；
4. 短回复保持当前行为，只在完成后发送一次；
5. 不重复、不漏发，不截断 UTF-8 字符；
6. 结构化动作、内部协议和自审草稿不得提前泄露；
7. 功能可以独立关闭，关闭后完全回到现有路径；
8. 不把 Codex、Telegram 和文本缓冲职责耦合在同一个模块里。

## 非目标

第一版不做：

- 不做逐 token 的打字机效果；
- 不持续编辑同一条 Telegram 消息；
- 不撤回已经封口的文本；
- 不保证流式草稿与运行时最终完成稿逐字一致；
- 不为进程中途崩溃持久化未完成的流状态；
- 不把该能力同时推广到微信或 QQ；
- 不改变 `/chunk` 的现有含义；
- 不为 Claude Code 伪造增量事件；当前没有 delta 时自然退回完成后发送。

## 核心语义：封口而不是实时编辑

```text
runtime.reply.delta
        ↓
追加到当前回复项的未发送缓冲
        ↓
达到封口阈值？ ── 否 ──→ 继续等待
        │
        是
        ↓
寻找安全自然边界并生成一个 ready chunk
        ↓
通过现有 channelAdapter.sendText 发送
        ↓
发送成功后推进 committed offset
        ↓
继续积累下一段
        ↓
reply.completed / turn.completed
        ↓
发送最后的未提交尾部并结束
```

“封口”表示一段一旦由 Telegram 确认发送成功，就成为观看者已经看到的事实。后续完成事件不修改这段内容，只处理尚未发送的尾部。

## 模块边界

### 1. 新增纯文本状态模块

建议新增：

```text
src/core/incremental-reply-buffer.js
```

它不引用 Telegram API、不读取配置文件、不访问 session store，也不发送网络请求。职责仅为：

- 兼容纯增量 delta、累计全文 delta 和重复 delta；
- 保存每个回复项的流式原文、已提交位置和未提交尾部；
- 判断当前是否能够提前发送；
- 在目标容量以内选择自然边界；
- 完成时协调流式文本与最终文本；
- 返回待发送文本片段及提交令牌；
- 仅在调用方确认发送成功后推进提交位置。

建议接口形状：

```js
const buffer = new IncrementalReplyBuffer({
  targetBytes: 3800,
  hardMaxBytes: 4096,
  carryBytes: 128,
});

buffer.append(deltaText);

const ready = buffer.peekReadyChunk();
// { token, rawText, deliveryText } | null

buffer.commit(ready.token); // 只在 sendText 成功后调用
buffer.reject(ready.token); // 发送失败时不推进 offset

const tail = buffer.finalize(finalText);
```

具体命名可以在实现时微调，但必须保留“先 peek、发送成功后 commit”的两阶段语义，不能在网络成功前丢弃缓冲。

### 2. StreamDelivery 只负责协调

`StreamDelivery` 继续持有每轮、每个 item 的生命周期。需要做的改动限制为：

- run state 中为普通回复 item 挂载一个增量缓冲器；
- 收到 `runtime.reply.delta` 后追加文本；
- 仅当目标 channel capability 允许时请求 ready chunk；
- 使用现有 `sendTextWithRetry` 发送；
- 成功后 commit，失败后保留待发内容；
- 完成事件发送尾部并按现有流程清理 run state。

不要在 `StreamDelivery` 中实现 UTF-8 切分、自然边界搜索或复杂的 Telegram 特例。

### 3. Telegram adapter 只声明能力并继续发送

Telegram adapter 不理解 runtime delta。它只通过 `describe().capabilities` 声明渠道能力，例如：

```js
incrementalTextDelivery: {
  mode: "sealed_chunks",
  enabled: true,
  targetBytes: 3800,
  hardMaxBytes: 4096,
}
```

`sendText` 仍保留现有最终安全切分，作为最后一道保护。即使上游误传超长片段，adapter 也不得向 Telegram 发送越界文本。

第一版应由配置决定 `enabled`，而不是在 core 中写死 `provider === "telegram"`。其他渠道没有声明能力时自然保持原行为。

## 配置

建议第一版增加两个环境配置：

```text
CYBERBOSS_TELEGRAM_STREAM_DELIVERY=false
CYBERBOSS_TELEGRAM_STREAM_FLUSH_BYTES=3800
```

规则：

- 首次发布默认关闭，完成测试后再为实际 Telegram bot 开启；
- `STREAM_FLUSH_BYTES` 必须小于渠道硬限制；
- 无效值回退到安全默认值；
- `/chunk` 继续控制完成文本的自然分段与短段合并；
- 第一版不新增 `/stream` 命令，避免同时引入命令状态持久化；稳定后再决定是否增加按账号或工作区开关。

当前 Telegram adapter 使用 `4096 UTF-8 bytes` 作为保守硬限制。第一版沿用这个既有规则，不在同一次改动中重新解释 Telegram 的“字符”计数，以免混入第二项兼容性变更。计数规则可在后续单独评估。

## 回复项状态

每个普通回复 item 建议维护：

```js
{
  currentText: "",       // 现有累计文本
  completedText: "",     // 运行时最终文本
  completed: false,
  incremental: {
    streamText: "",      // 规范化后的流式原文
    committedRawLength: 0,
    sequence: 0,
    hadEarlyCommit: false,
    pendingCommit: null,
    finalized: false,
  },
}
```

这只是概念结构。实现可以把状态封装在类中，避免 `StreamDelivery` 直接修改内部字段。

状态约束：

1. 同一 item 同时最多存在一个 pending commit；
2. `committedRawLength` 只能单调增加；
3. 只有网络发送成功才能 commit；
4. item finalize 后不得继续产生 ready chunk；
5. run dispose 时释放所有未完成缓冲；
6. 不再只依赖 `sentItemIds` 表示整个 item 是否发送，因为一个 item 可以只发送了一部分。

## delta 合并

沿用现有 `appendStreamingText` 的兼容目标，并把相关逻辑移动或复用到纯缓冲模块：

- `next` 是新 token：追加；
- `next` 是到目前为止的累计全文：用较长累计值替换；
- `next` 与现有尾部重复：去重；
- `next` 与现有文本部分重叠：只追加不重叠部分；
- 无法判断关系：保守追加并记录诊断计数。

不得假定所有 runtime 都只发送单一形态的 delta。

## 封口边界

普通正文达到 `targetBytes` 后，按以下优先级向前寻找切点：

1. 空行或段落结束；
2. 换行；
3. 中文句号、问号、感叹号及其连续引号；
4. 英文句末标点与空格；
5. 其他安全字符边界；
6. 超过 `hardMaxBytes` 仍没有自然边界时，使用现有 UTF-8 安全切分逻辑硬切。

保留一个小型 `carryBytes` 尾部，防止尚未完整到达的协议标记、Markdown 标记或 Telegram inline keyboard 注释被从中间切开。封口结果必须再次经过现有 Markdown 转纯文本与协议泄露清理，然后由 Telegram adapter 做最终长度校验。

如果转换后的 `deliveryText` 为空，可以提交对应的原始区间但不发送；必须记录原因，避免同一段永久堵塞。

## 不允许提前发送的内容

满足任一条件时，该 item 在完成前保持缓冲：

- reply target 是 `system`；
- channel 没有声明 `sealed_chunks` 能力；
- 功能开关关闭；
- item 是 thinking；
- 文本疑似以 JSON action、`json:` 或 JSON code fence 开头；
- 文本包含尚未闭合的内部协议或工具标记；
- 当前尾部包含尚未闭合的 Telegram inline keyboard 注释；
- reply self-review 已拦截 delta；
- 无法确认该文本是可以公开发送的普通回复。

对于普通 Markdown code fence，第一版优先完整保留围栏；如果一个围栏自身超过硬限制，再走明确测试过的长代码块降级路径。不能为了提前发送而把半个内部 JSON 当正文送出。

## 完成文本与流式文本不一致

苏苏接受封口后的前文与最终完成稿不完全一致，因此第一版采用简单、可预测的规则：

### 尚未发生提前提交

完全沿用当前行为，以 `completedText` 为准。短回复和被保护内容不会发生体验变化。

### 已经发生提前提交

1. 如果 `completedText` 以已提交流式前缀开头：以完成文本替换尚未发送的尾部，然后发送剩余部分；
2. 如果完成文本重写了已经提交的前缀：已提交部分保持不变，流式缓冲成为该 item 的投递事实来源；
3. 此时发送尚未提交的流式尾部，不尝试撤回或编辑旧消息；
4. 写一条不含正文内容的 mismatch 诊断日志；
5. 不把整个完成稿重新发送，否则会造成肉眼可见的重复。

第一版不追求“最终稿覆盖一切”。这是控制复杂度、避免引入 Telegram 消息编辑状态机的明确取舍。

## Inline keyboard 与尾部指令

Telegram inline keyboard 指令只能附着在最后一次完成发送上：

- 提前封口的片段不携带按钮；
- 缓冲器不得把 `<!--telegram-inline-keyboard:...-->` 的任何部分作为正文发送；
- 完成时继续复用现有 `extractTelegramInlineKeyboard`；
- 如果完成文本与流式文本不一致，仍可从完成文本提取合法按钮，但不能因此重发正文；
- 纯按钮结果继续使用现有占位文本规则。

## 与 reply self-review 的关系

`ReplySelfReviewController` 当前会在自审适用时吞掉 `runtime.reply.delta`，直到完整草稿生成并完成判断。这个行为必须保留。

因此：

- `/selfreview off`：满足其他条件时可增量封口发送；
- `/selfreview on`：当前架构下自然退回完整回复完成后发送；
- 不允许为了流式体验绕过 controller 直接订阅原始 runtime delta；
- 后续若实现 Telegram message edit，再单独评估“先发草稿、审后编辑”，不纳入本方案。

## 失败、停止与重试

### 网络代理

Telegram 请求继续复用现有缓存的 `undici.ProxyAgent`，增量投递不创建第二套代理连接。封口片段通过现有 `sendText` 和顺序 `sendChain` 投递，因此代理配置、Bot API 地址和账号绑定均不改变。

代理发送一旦失败：

- 当前 pending chunk 不 commit；
- 当前 item 暂停继续提前封口，避免每个后续 delta 都立即重撞代理；
- 完成事件到来后，未提交正文通过原有完成投递路径再尝试一次；
- 已经 commit 的片段不会因为尾部失败而重发；
- 超时存在“Telegram 已收到但本地没有收到确认”的固有歧义，第一版不引入消息编辑或幂等数据库。

### Telegram 发送失败

- `sendTextWithRetry` 成功前不得 commit；
- 明确失败时保留 pending chunk，交给现有重试/延迟机制；
- 网络超时存在“Telegram 已收到但本地未收到确认”的固有歧义，第一版维持至少一次投递语义，极端情况下可能重复；
- 不为解决这一极小窗口引入全局幂等数据库。

### 模型失败或用户 `/stop`

- 已成功封口的消息继续保留；
- 尚未发送的尾部根据现有 turn failed 策略丢弃；
- 可在后续增加简短的“生成已中断”提示，本方案不强制，以免改变现有失败体验。

### 进程退出

- 已到达 Telegram 的片段不会丢失；
- 内存中未封口的尾部不恢复；
- 第一版不持久化进行中的 run state。

## 顺序与并发

现有 runtime event chain 按事件顺序串行处理，`StreamDelivery` 也已有 `sendChain`。实现时继续依赖这两个顺序保证：

- 同一回复 item 的 chunk 严格按 sequence 发送；
- 一个 chunk 发送未决时不产生第二个 pending commit；
- 不允许完成事件越过仍在发送的 chunk；
- 不同 turn 的 reply target 和 run state 仍按现有 run key 隔离；
- 不额外创建无约束的 fire-and-forget Promise。

发送一条 Telegram 消息期间，runtime websocket 仍可接收事件，但事件处理链可以等待网络结果。封口频率较低，这比引入并发乱序更安全。

## 日志与可观测性

新增结构化诊断日志，但不打印完整私密正文：

```text
[stream-delivery] chunk ready thread=<id> turn=<id> item=<id> seq=<n> bytes=<n>
[stream-delivery] chunk committed ...
[stream-delivery] final mismatch ... committedBytes=<n>
[stream-delivery] incremental disabled reason=<reason>
```

正常运行不需要为每个 token 打日志。只记录封口、提交、失败、最终不一致和安全降级事件。

## 预计文件变更

新增：

- `src/core/incremental-reply-buffer.js`
- `test/incremental-reply-buffer.test.js`

修改：

- `src/core/stream-delivery.js`：挂接缓冲器、发送 ready chunk、完成尾部；
- `src/core/config.js`：读取 Telegram 增量发送配置；
- `src/adapters/channel/telegram/index.js`：声明 capability，保留最终硬切；
- `test/stream-delivery.test.js`：验证渠道集成、完成语义和自审边界；
- `test/telegram-chunks.test.js`：补充分段器与 adapter 最终保护测试；
- 示例环境变量文档：只在仓库已有对应示例文件且不涉及真实密钥时更新。

不修改：

- Codex RPC 协议与事件映射；
- Telegram Bot token、账号绑定和 offset 存储；
- `/chunk` 命令；
- 微信和 QQ adapter；
- chat memory 的最终文本采集语义；
- reply self-review 的审阅规则。

## 测试矩阵

### 纯缓冲器测试

1. 小于阈值时不返回 ready chunk；
2. 达到阈值后在最近段落边界封口；
3. 无自然边界时 UTF-8 安全硬切；
4. 中文、emoji、组合字符不产生损坏；
5. 纯增量 delta 正确追加；
6. 累计全文 delta 不重复；
7. 重复 delta 不重复；
8. 部分重叠 delta 正确合并；
9. 发送失败后 offset 不推进；
10. commit 后同一片段不再返回；
11. 完成文本与已提交前缀一致时使用最终尾部；
12. 完成文本重写前缀时使用流式尾部且不重复全文；
13. JSON action 和未闭合协议标记不提前封口；
14. inline keyboard 注释完整保留到 finalize；
15. finalize 后拒绝新的提交。

### StreamDelivery 集成测试

1. Telegram 长回复在 `turn.completed` 前至少发送一条；
2. Telegram 短回复仍只在完成时发送；
3. 功能关闭时行为与当前测试完全一致；
4. 微信、QQ、system target 不提前发送；
5. thinking 不进入正文封口；
6. 多个 item 保持顺序且互不复用 offset；
7. 两个并行 turn 的状态互不污染；
8. 发送失败、重试成功后只 commit 一次；
9. `turn.failed` 后不发送未封口尾部；
10. 自审启用时 delta 不绕过审阅；
11. 结构化 `send_message`、`silent` 和非法 action 不泄露 JSON；
12. deferred prefix 不造成首条消息重复。

### Telegram adapter 测试

1. 每个最终请求都在现有硬限制内；
2. 超长中文和 emoji 可以完整拼回原文；
3. 提前片段不带 inline keyboard；
4. 按钮只附着于最后一条；
5. adapter 的二次安全切分仍有效；
6. 多条发送继续遵守既有发送间隔。

## 实施顺序

1. 固化并运行现有 `stream-delivery`、Telegram chunk 和 self-review 测试作为基线；
2. 新增纯 `IncrementalReplyBuffer` 及完整单元测试，不接入生产路径；
3. 为 Telegram 增加关闭状态的 capability/config，验证关闭时无行为差异；
4. 在 `StreamDelivery` 的 delta 路径挂接 ready chunk，但只在 capability 开启时执行；
5. 实现 finalize、一致前缀和 mismatch 分支；
6. 加入 action、inline keyboard、自审和失败保护；
7. 跑相关测试和完整测试套件；
8. 在测试 bot 或隔离会话中开启，验证长中文回复的首次送达时间；
9. 观察无重复、无协议泄露后，再为正式 Telegram bot 开启；
10. 保留关闭开关作为即时回退路径。

## 验收标准

1. 功能开启后，足够长的普通 Codex 回复能在运行时完成前到达 Telegram；
2. 追加型 delta 下，所有已发片段和最终尾部拼接后与流式正文一致；
3. 短回复的消息数量和内容与当前实现一致；
4. 没有重复片段、UTF-8 损坏或越过 Telegram adapter 硬限制的请求；
5. 最终文本重写已提交前缀时不重发全文；
6. inline keyboard 只出现在最后一条消息；
7. JSON action、内部协议、thinking 和自审草稿不提前泄露；
8. 功能关闭后所有现有测试与行为保持不变；
9. 微信、QQ、system reply 和 chat memory 不发生非预期变化；
10. 新逻辑主要存在于独立纯模块，`StreamDelivery` 只承担协调职责。

## 后续可选能力

第一版稳定后再评估：

- `/stream on|off|status` 按 Telegram 账号保存；
- 将阈值从 byte 规则升级为 Telegram 官方字符/实体规则；
- 用 `editMessageText` 做可选的单条实时预览；
- 保存 Telegram message ID，在最终重写时允许编辑已发片段；
- 为中途停止补充明确的“生成已中断”尾注；
- 将 capability 推广为其他渠道可复用的 sealed chunk 协议。

这些能力不应提前塞进第一版；第一版只解决“长回复生成到一条消息容量后尽快送达”这一件事。
