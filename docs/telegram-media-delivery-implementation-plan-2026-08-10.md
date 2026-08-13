# Telegram 文件与富媒体发送适配实现方案

> 日期：2026-08-10  
> 状态：核心路由、Telegram 原生媒体与入站类型已实施；媒体组和链接预览控制待后续按需补充

## 2026-08-12 实施边界决定

本项目暂不为文件投递引入新的 turn-scoped registry、delivery lease 或 MCP 协议字段，也不重构 Cyberboss 原有的 runtime/tool 生命周期。

采用最小改动方案：

1. 继续使用现有 `RuntimeContextStore` 作为独立 MCP 工具进程获取当前聊天目标的桥；
2. 在启动 runtime turn、模型能够调用工具以前，先写入本轮入站消息的通道目标；
3. turn 创建成功后仅回填真实 `threadId`；
4. `ChannelFileService` 保持通道无关，不重新引入微信账号、微信 token store 或 Telegram API 细节；
5. 微信 adapter 和原有文字回复链路不改；
6. Telegram 原生媒体能力保留在 Telegram adapter 内；
7. 当前设计以一个 workspace 同时只有一个实际执行中的主 turn 为使用前提，不为理论上的多 turn 并发扩建基础设施。

这是一项针对现有结构的时序修复，不把 `RuntimeContextStore` 重新定义成永久可靠的“最后收件人”数据库。`last-active` 和默认通道只适合作为无当前 turn 的兼容回退。

### 当前代码对照审计

截至 2026-08-12：

- 普通 Telegram 入站消息会携带真实 `chatId` 和 `tg:<chatId>`，并在 `sendTurn()` 前写入工具上下文；当前 turn 内调用 `cyberboss_channel_send_file` 的主路径符合本方案；
- `ChannelFileService` 已与微信账号及 `context_token` store 解耦，符合本方案；
- 微信 adapter 未因本改造改变，符合本方案；
- Telegram 的 photo/document/video/audio/voice/animation 发送与相关入站类型均留在 Telegram adapter 内，符合本方案；
- 当前实现额外引入了独立 `ChannelDeliveryTargetResolver`。它是小型依赖注入组件，不改变 Cyberboss runtime 结构，但比单纯移动写入时序多了一层抽象；保留它是为了避免 `ChannelFileService` 再次耦合具体通道；
- 后台 system turn 当前可能通过 last-active 选中 Telegram，却仍携带 canonical 微信 sender ID 和空 Telegram token，从而把 `RuntimeContextStore` 写成混合目标；这不影响下一条普通 Telegram turn 在执行前覆盖上下文，但 system turn 自己调用文件工具时目标不可用；
- `sendLocalFileToCurrentChat()`、延迟 timeline screenshot 等没有当前 turn context 的主动发送路径，在 last-active 为 Telegram 且只持有 canonical sender ID 时，当前 resolver 不能反查 Telegram external chat ID；这类调用会失败；
- 工具参数中的显式 `channelId` 当前排在有效 context target 之后，不能覆盖当前 turn 的投递通道。对正常回复这是防串台保护，但与早期文档所写的“显式目标覆盖当前目标”不同；最终决定以当前 turn 不可被模型参数改投为准。

### 当前可用范围

可以直接使用：

```text
Telegram 用户消息 → 当前 Cyberboss turn → channel_send_file → 原 Telegram chat
微信用户消息 → 当前 Cyberboss turn → channel_send_file → 原微信聊天
```

尚未保证：

```text
后台 system turn → 生成并主动发送文件
延迟 timeline screenshot → 根据 last-active 主动发送到 Telegram
没有当前 turn、仅凭 canonical sender ID → 主动发送到 Telegram
```

这些旁路以后若确实需要，优先做局部修正：由已有 identity map 将 canonical sender ID 解析成 Telegram external chat ID，并让 system message 携带一个完整、成对的 delivery target；不引入新的全局 registry。

## 背景

Cyberboss 已经可以同时接收微信和 Telegram 消息，普通文本回复也能按触发当前 turn 的来源通道正确返回。但是，当运行中的 Cyberboss 线程调用 `cyberboss_channel_send_file` 发送本地文件时，文件服务仍固定使用微信账号、微信 `context_token` 和默认微信 adapter。

因此当前行为是：

```text
Telegram 消息 → Cyberboss 线程 → 普通文字回复 Telegram
                              └→ channel_send_file → 微信
```

这不是 Telegram Bot API 缺少文件能力。Telegram adapter 已实现 `sendPhoto`、`sendDocument`，也能接收并保存图片、文档、视频、语音和静态贴纸。真正缺失的是：工具调用没有继承当前线程的 reply target，且通用发送接口尚未表达 Telegram 的原生媒体类型。

## 目标

第一阶段必须实现：

1. 线程从 Telegram 收到消息后，`cyberboss_channel_send_file` 默认把文件发回同一个 Telegram chat；
2. 线程从微信收到消息后，现有微信发文件行为不变；
3. 文件发送目标与文本回复使用同一套通道路由依据；
4. 工具仍可通过显式目标覆盖默认目标，但不能因为 canonical sender ID 相同而误发到另一通道；
5. 没有可靠发送目标时明确失败，不静默改投微信；
6. 保持旧调用 `{ filePath, userId? }` 可用。

后续阶段实现：

- Telegram 原生图片、视频、音频、语音、动画和普通文件发送；
- caption、文件名和链接预览选项；
- Telegram 入站 `audio`、`animation`、`video_note` 等类型；
- 为媒体组、贴纸、位置、联系人等能力保留扩展空间。

## 非目标

本次不把所有通道强行做成能力完全相同的最低公分母，也不在第一阶段实现：

- Telegram 相册或 `sendMediaGroup`；
- Telegram 联系人、位置、投票或消息转发；
- 远程 URL 下载后转发；
- 文件管理器或媒体素材库；
- 自动把任意正文中的本地路径识别为附件；
- 改变入站附件交给 Codex/Claude runtime 的现有流程。

## 当前实现与根因

### 普通回复链路已经是 channel-aware

`CyberbossApp.dispatchPreparedTurn()` 会从入站消息保存：

```js
{
  userId: prepared.senderId,
  contextToken: prepared.contextToken,
  provider: prepared.provider,
}
```

`StreamDelivery` 再根据 reply target 选择相应 channel adapter。因此同一 canonical 用户从 Telegram 发起的 turn，普通回复仍会回到 Telegram。

### 文件工具仍绑定默认微信 adapter

当前 `CyberbossApp` 为兼容旧代码设置：

```js
this.channelAdapter = this.channels.get("weixin") || firstEnabledChannel;
```

`createProjectTooling()` 把这个单一 adapter 传给 `ChannelFileService`。而 `ChannelFileService.sendToCurrentChat()` 又直接：

- 调用微信 `resolveSelectedAccount()`；
- 调用微信 `loadPersistedContextTokens()`；
- 用微信 account ID 解析默认用户；
- 要求存在微信 `context_token`；
- 最终调用构造时注入的微信 adapter。

所以即使工具是在 Telegram turn 内调用，它也不知道当前 turn 的 Telegram `chat_id`。

### Telegram adapter 当前能力

出站：

- `.png/.jpg/.jpeg/.webp` 调用 `sendPhoto`；
- 其他扩展名调用 `sendDocument`；
- 底层上传函数已支持 caption，但 adapter 没有对外开放；
- 尚无 `sendVideo/sendAudio/sendVoice/sendAnimation`。

入站：

- 已识别 `photo/document/video/voice/sticker`；
- 已通过 `getFile` 下载到本地 inbox；
- `audio` 会生成 `[voice message]` 文本，但没有进入附件提取结果；
- 未处理 `animation/video_note`；
- 动态及视频贴纸不能按普通 `.webp` 图片完整处理。

### 微信与 Telegram 的关键差异

| 方面 | 微信 | Telegram |
|---|---|---|
| 回复地址 | user ID + 会变化的 `context_token` | 稳定 `chat_id` |
| 文本限制 | 项目按约 3800 字符及单轮条数打包 | Bot API 单条 4096 bytes |
| 文件发送 | 上传并映射微信媒体类型 | 按 `sendPhoto/sendDocument/...` 原生方法发送 |
| 图片与文件 | 由微信媒体协议决定 | 图片作为 photo 和作为 document 的显示、压缩行为不同 |
| 链接 | 普通文本 | 普通文本可自动生成预览，并可控制预览选项 |
| 交互 | 当前主要为文本 | 已支持 inline keyboard、callback 和 ForceReply |

路由层应统一“发给谁、发到哪个通道”，adapter 层应保留各通道自己的媒体语义。

## 总体设计

```text
MCP tool / App API
        ↓
ChannelDeliveryService
  1. resolve delivery target
  2. validate local source
  3. choose channel adapter
        ↓
Channel adapter capability
  sendMedia() 优先
  sendFile() 兼容回退
        ↓
Weixin media upload / Telegram Bot API
```

核心原则：

- 目标解析与媒体发送分离；
- service 不导入任何微信或 Telegram account store；
- 通道凭据和地址细节由各 adapter 自己处理；
- 当前 turn 的精确 reply target 优先级最高；
- canonical identity 用于关联身份，不能单独决定投递通道；
- 不支持某个原生媒体类型时，可以降级成 document/file，但不能降级到另一通道。

## 第一阶段：修复文件发送路由

### 1. 扩展工具调用上下文

`ProjectToolHost` 调用工具 handler 时已有 `context`。需要确保运行时工具调用上下文至少可以解析到：

```js
{
  threadId,
  bindingKey,
  senderId,          // canonical sender ID
  provider,          // telegram | weixin | system
  channelId,
  externalUserId,    // Telegram chat/user ID 等真实通道地址
  contextToken,
}
```

不建议让模型填写这些字段。它们必须由 Cyberboss 根据当前 runtime thread/binding 注入，避免模型猜测 chat ID 或拿错通道。

如果工具宿主当前只能得到 `threadId`，则通过 `RuntimeContextStore`、session binding 和现有 reply-target store 解析其余字段。

### 2. 提供统一的目标解析器

为项目工具注入一个 resolver，例如：

```js
async function resolveDeliveryTarget({ context, userId, channelId }) {
  // return { channelId, userId, contextToken, provider }
}
```

推荐解析顺序：

1. 当前 turn/thread 绑定的精确 reply target；
2. 显式提供的 `channelId + userId`；
3. 当前 binding 对应的最近 reply target；
4. canonical 用户的 last-active channel；
5. 仅为旧的非线程内部调用保留默认通道回退。

约束：

- 如果存在当前 turn target，旧参数中的 canonical `userId` 只用于一致性校验，不覆盖 Telegram external ID；
- 只给 `userId`、且该身份同时绑定微信和 Telegram 时，优先 last-active channel；若仍无法唯一确定则报错；
- provider 为 `system` 时不能凭空推断用户，必须通过 binding/thread 找到目标；
- Telegram target 规范化为 `{ channelId: "telegram", userId: chatId, contextToken: "tg:<chatId>" }`；
- 微信 target 必须保留有效 `contextToken`。

### 3. 重构 ChannelFileService

构造函数由：

```js
new ChannelFileService({ config, channelAdapter, sessionStore })
```

调整为类似：

```js
new ChannelFileService({
  config,
  sessionStore,
  resolveTarget,
  resolveChannel,
})
```

`sendToCurrentChat()` 只负责：

1. 验证并解析本地文件路径；
2. 调用 `resolveTarget()`；
3. 通过 `resolveChannel(target.channelId)` 获取 adapter；
4. 调用目标 adapter 的 `sendFile()`；
5. 返回实际投递信息。

建议返回：

```js
{
  channelId: "telegram",
  userId: "123456789",
  contextToken: "tg:123456789",
  filePath: "C:\\...\\report.pdf",
  deliveryKind: "document"
}
```

返回结果不应包含 bot token、微信 token 或其他凭据。

### 4. 更新工具定义

第一阶段保留工具名 `cyberboss_channel_send_file`，避免破坏已有 prompt 和授权配置。

描述改为：

> Send an existing local file back to the chat associated with the current Cyberboss thread.

输入兼容旧接口，并加入可选通道覆盖：

```js
{
  filePath: string,          // required
  userId?: string,
  channelId?: "weixin" | "telegram"
}
```

正常的当前线程回复只传 `filePath`。显式覆盖主要供维护、系统任务和未来管理界面使用。

### 5. 兼容 App 内部发送接口

`sendLocalFileToCurrentChat()` 也应接受或解析 thread/binding context，不再直接把空 context 交给微信文件服务。若它是 CLI/管理接口且没有线程上下文，可使用显式 `senderId/channelId` 或 last-active 回退。

贴纸服务目前复用 `ChannelFileService`，需要验证：

- 微信现有贴纸行为不变；
- Telegram 若发送本地 `.webp`，第一阶段至少能作为 photo/document 投递；
- 不在第一阶段把微信贴纸 ID 误映射为 Telegram sticker ID。

## 第二阶段：统一媒体接口与 Telegram 原生类型

### adapter 契约

在保留 `sendFile()` 的同时新增：

```js
channel.sendMedia({
  userId,
  contextToken,
  source: {
    type: "local_file",
    path: absolutePath,
  },
  kind: "auto", // photo | document | video | audio | voice | animation
  caption: "",
  fileName: "",
  options: {},
})
```

`sendFile()` 可作为兼容包装：

```js
sendFile(payload) {
  return sendMedia({ ...payload, kind: "auto" });
}
```

### 类型推断

推断顺序：

1. 调用方显式 `kind`；
2. MIME type；
3. 文件扩展名；
4. `document`。

推荐映射：

| 类型 | Telegram 方法 | 不支持时降级 |
|---|---|---|
| photo | `sendPhoto` | `sendDocument` |
| video | `sendVideo` | `sendDocument` |
| audio | `sendAudio` | `sendDocument` |
| voice | `sendVoice` | `sendDocument` |
| animation | `sendAnimation` | `sendDocument` |
| document | `sendDocument` | 失败 |

注意图片作为 `photo` 可能被 Telegram 处理或压缩。需要保留显式 `kind: "document"`，用于发送原图、设计稿、截图证据等不希望改变字节的文件。

### Telegram API 层

把当前 `uploadFile()` 保留为统一 multipart 实现，新增轻量包装：

```js
sendVideo(...)
sendAudio(...)
sendVoice(...)
sendAnimation(...)
```

每个包装只指定：

- Bot API method；
- multipart file field；
- 可选参数白名单。

caption 第一版按 Telegram plain text 发送；若支持 `parse_mode`，必须复用文本安全策略，避免未经处理的模型文本导致 Telegram HTML/Markdown 解析失败。

### 能力声明

adapter 的 `describe().capabilities` 增加结构化能力：

```js
media: {
  send: ["photo", "document", "video", "audio", "voice", "animation"],
  caption: true,
  mediaGroup: false,
  linkPreviewOptions: true,
}
```

不要只保留 `supportsAttachments: true`；它无法表达通道间真实差异。

## 第三阶段：链接与结构化消息

分享链接本质上不是附件。普通链接继续通过 `sendText()` 发送，Telegram 客户端自然生成预览。

如果需要可控体验，扩展文本接口而不是把 URL 伪装成文件：

```js
sendText({
  userId,
  text,
  contextToken,
  options: {
    linkPreview: "auto" | "enabled" | "disabled",
    silent: false,
  },
})
```

Telegram adapter 将其映射到 Bot API 的 link preview options；微信 adapter 忽略无法表达的选项。inline keyboard 继续使用现有 Telegram directive，未来可以再改成结构化 `buttons` 字段。

## 入站补全

在 `telegram/message-utils.js` 中补充：

- `message.audio` → `kind: "audio"`；
- `message.animation` → `kind: "animation"`；
- `message.video_note` → `kind: "video"`，保留 `itemType: "video_note"`；
- 对 animated/video sticker 明确标记，避免一律假设 `.webp`；
- caption 与附件继续保存在同一个 normalized message 中。

相册消息具有相同 `media_group_id`，但 Telegram 会把每项作为独立 update 送达。第三阶段以前保持逐条接收；若实现相册合并，应在短窗口内按 `chat_id + media_group_id` 聚合，并复用现有最多 10 张图片的 runtime batch 约束。

## 错误处理与安全边界

### 本地文件

延续当前规则：

- 路径解析为绝对路径；
- 必须存在且为普通文件；
- 不接受目录；
- adapter 发送前再次读取文件，读取失败直接返回错误。

本方案不额外限制文件必须位于 workspace，因为当前工具本来就允许发送现有本地文件；如果以后面向不可信调用方开放 HTTP API，应另加允许根目录策略。

### 目标安全

- 绝不从文件名、caption 或正文推断收件人；
- 绝不因 Telegram 发送失败自动改投微信；
- 显式 `channelId` 不存在或未启用时直接失败；
- Telegram `chat_id` 必须满足 adapter 当前允许列表和 identity binding 策略；
- 日志只记录 channel ID、脱敏目标和文件 basename，不记录 token；
- 错误信息可以指出缺少 chat ID/context token，但不能暴露凭据内容。

### 大文件与 Bot API 限制

不要在业务层硬编码一个可能随 Telegram 部署方式变化的单一上限。adapter 应：

1. 可选进行配置化的发送前大小检查；
2. 保留 Bot API 原始错误摘要；
3. 返回带 `channelId/kind/fileSize` 的可诊断错误；
4. 不自动压缩或转码用户文件。

## 测试计划

### ChannelFileService 单元测试

新增独立测试，覆盖：

1. 当前 target 为 Telegram 时调用 Telegram adapter；
2. 当前 target 为微信时调用微信 adapter；
3. Telegram target 不读取微信 account store/context-token store；
4. 相同 canonical 用户同时绑定两端时不串台；
5. 显式 `channelId + userId` 覆盖无上下文调用；
6. 无法唯一解析目标时失败；
7. 文件不存在和目录路径仍失败；
8. 返回结果包含实际 channel ID，不包含凭据。

### Tool host 测试

覆盖：

- `cyberboss_channel_send_file` 把 runtime context 原样传给 service；
- 旧 `{ filePath }` 调用仍有效；
- 工具描述不再声称只支持微信；
- 授权配置和工具名保持不变。

### Telegram adapter 测试

第一阶段：

- 图片扩展名走 `sendPhoto`；
- PDF/ZIP 等走 `sendDocument`；
- `tg:<chatId>` 和数值 user ID 都能解析；
- 无 chat ID 时失败。

第二阶段：

- 显式 photo/document 覆盖自动推断；
- 视频、音频、语音、动画使用正确 method 与 multipart field；
- caption 正确传递；
- 原生类型不支持时按约定降级；
- API 错误不会触发跨通道重试。

### 入站测试

- `audio/animation/video_note` 被提取并持久化；
- caption 不丢失；
- animated/video sticker 扩展名和 kind 正确；
- 同一消息的文本和附件仍作为一个 prepared turn；
- 纯附件下载失败时错误返回原通道。

### 端到端验收

至少人工验证以下场景：

1. Telegram 发“生成一个 txt 给我” → 文件只出现在原 Telegram chat；
2. Telegram 请求 PNG → 以可预览图片发送；
3. Telegram 请求 PDF/ZIP → 以 document 发送且文件名保留；
4. 微信执行相同请求 → 行为与改造前一致；
5. 同一 canonical 用户先后从微信、Telegram 发消息 → 每个 turn 的附件回到各自来源；
6. Telegram turn 运行期间用户又从微信发消息 → 旧 turn 的文件仍回 Telegram，不被 last-active 覆盖；
7. Telegram 发送失败 → 微信不出现意外副本；
8. Telegram 分享链接 → 正文和预览正常，且不走文件工具。

第 6 项是最重要的并发回归测试：路由必须绑定 turn，而不是只看全局“最后活跃通道”。

## 实施顺序

### PR 1：路由修复

- 为文件服务注入 target/channel resolver；
- 复用当前线程 reply target；
- 去除文件服务中的微信专属依赖；
- 更新工具描述与返回结构；
- 增加双通道路由测试；
- 保持 adapter `sendFile()` 不变。

完成标准：Telegram 线程可稳定把图片和普通文件发回自身，微信无回归。

### PR 2：Telegram 原生媒体

- 新增 `sendMedia()` 契约；
- Telegram 增加 video/audio/voice/animation；
- 支持 caption 和显式 document 原图模式；
- 增加结构化 capability；
- 补齐 adapter 测试。

### PR 3：入站与链接完善

- 补 `audio/animation/video_note`；
- 改善动态贴纸处理；
- 加入链接预览选项；
- 视实际需要实现媒体组聚合。

## 预计修改位置

第一阶段主要涉及：

- `src/services/channel-file-service.js`
- `src/tools/create-project-tooling.js`
- `src/tools/tool-host.js`
- `src/core/app.js`
- `src/core/runtime-context-store.js`（若现有上下文不足）
- `src/core/stream-delivery.js` 或抽出的 reply-target resolver
- `test/channel-file-service.test.js`（新增）
- `test/tool-host.test.js`
- 相关 app/路由集成测试

第二、三阶段再涉及：

- `src/adapters/channel/telegram/api.js`
- `src/adapters/channel/telegram/index.js`
- `src/adapters/channel/telegram/message-utils.js`
- `src/adapters/channel/telegram/media-receive.js`
- `src/adapters/channel/weixin/index.js`
- `test/telegram-chunks.test.js` 或新增 Telegram media 测试
- `test/system-inbound.test.js`

## 风险与决策

### 不直接让 ChannelFileService 使用 ChannelRouter

可以注入 resolver，而不让 service import `CyberbossApp` 或全局 router。这样 service 仍可独立测试，也避免工具层与 app 生命周期形成循环依赖。

### 不只依赖 last-active channel

last-active 适合主动消息的回退，不适合运行中 turn 的精确回复。用户可能在 Telegram turn 尚未结束时从微信发来新消息；若只查 last-active，旧 turn 的文件就会串台。

### 不立即删除 sendFile

现有贴纸服务、App API 和工具都在使用 `sendFile()`。先保留兼容包装，再逐步迁移到 `sendMedia()`，能把路由修复和媒体能力扩展拆开验证。

### 不把链接建模为附件

链接的关键差异是预览和交互选项，不是二进制上传。单独保留在文本/结构化消息接口里，能避免下载不可信 URL，也符合 Telegram 的原生行为。

## 最终验收标准

方案全部完成后，Cyberboss 应满足：

- 每个 turn 的文本和附件共享同一个精确投递目标；
- 微信凭据逻辑只存在于微信 adapter 内；
- Telegram chat ID 逻辑只存在于 Telegram adapter/target resolver 内；
- 工具不需要知道通道 API 细节；
- 图片、视频、音频、语音、动画和普通文件能在 Telegram 使用合适的原生表现；
- 不支持的媒体能力只在同一通道内安全降级；
- 分享链接通过文本消息发送并可控制预览；
- 双通道并发时不存在文件串台。
