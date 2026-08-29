# Telegram 文件发送故障记录（2026-08-16）

## 现象

- `cyberboss_channel_send_file` 发送 Telegram 文档时，Telegram Bot API 返回 HTTP 400：`there is no document in the request`。
- 即使换成 ASCII 文件名和路径，错误仍然存在。
- 从微信会话显式指定 `channelId: telegram` 时，目标渠道可能仍被解析为当前微信会话。

## 已确认原因

### 1. 代理分支混用了两套 Fetch API 对象

`src/adapters/channel/telegram/api.js` 使用 Node 全局 `FormData` 和 `Blob` 构造上传表单；检测到代理后，`fetchWithProxy` 却改用 npm 依赖中的 `undici.fetch`。

在当前环境（Node v24.14.1、undici 8.3.0、已配置代理）中，这个组合不会被 `undici.fetch` 识别为 multipart 表单。本地 HTTP 接收器实测结果：

- `Content-Type` 为 `text/plain;charset=UTF-8`
- 请求正文为 `[object FormData]`
- 不存在 `name="document"` 字段

因此 Telegram 的报错准确反映了实际请求内容。文件路径、中文文件名和 TXT 内容不是根因。

### 2. 当前上下文覆盖显式渠道参数

`src/services/channel-delivery-target-resolver.js` 先解析并返回当前运行时上下文，再处理调用参数中的 `channelId`。因此当前上下文是微信时，显式请求 Telegram 也会被提前截获。

## 修改方案

### 上传实现

1. 在 Telegram API 模块中统一 Fetch API 实现：`fetch`、`FormData`、`Blob` 必须来自兼容的同一套实现。
2. 推荐统一使用项目依赖 `undici` 提供的实现，并让无代理与有代理分支共用同一个 `fetch`；代理分支只额外传入 `dispatcher`。
3. 不手动设置 multipart 的 `Content-Type`，由 `FormData` 自动生成带 boundary 的请求头。

### 目标渠道解析

1. 调用参数明确提供 `channelId` 时，应优先于当前运行时上下文。
2. 跨渠道发送 Telegram 文件时必须能解析到明确的 Telegram chat ID；不能只拿微信侧的 canonical user ID 直接充当 chat ID。
3. 若缺少目标 chat ID，应返回清楚的目标解析错误，不能静默回落到其他渠道。

### 测试补充

1. 增加本地 HTTP 接收器测试，断言请求头为 `multipart/form-data; boundary=...`。
2. 断言请求体包含 `name="document"`、文件名和文件内容。
3. 分别覆盖无代理和代理分支。
4. 增加“当前上下文为微信、显式目标为 Telegram”的目标优先级测试。

## 临时绕行方案

在正式修复并重启前，可直接使用 `curl.exe -F` 调用 Telegram Bot API 上传文件。curl 会自行构造正确的 multipart 请求，不经过当前损坏的 Node `FormData` 路径，也不需要重启 Cyberboss。

## 验证状态

- 现有相关测试：34 项通过；这些测试仅验证适配器调用，没有检查实际 HTTP multipart 字节，因此未覆盖本故障。
- 本地复现：已确认代理分支发送的是纯文本 `[object FormData]`。
- 本记录只新增文档，尚未修改运行代码或配置，不需要重启服务。

## 2026-08-26 修复实施记录

状态：已实施，等待运行中的 Cyberboss 服务重启后生效。

### 已实施

1. Telegram 代理上传不再把 Node 全局 `FormData` 交给 `undici.fetch`。代理分支现在使用 `undici.fetch + undici.FormData + ProxyAgent`，文件值使用已由本地代理回归测试确认兼容的 Node `Blob`；无代理分支继续成对使用 Node 全局 Fetch API。
2. 新增 `test/telegram-api-proxy.test.js`，通过本地 HTTP CONNECT 代理和接收器检查真实请求字节，断言：
   - `Content-Type` 是带 boundary 的 `multipart/form-data`；
   - 正文包含 `chat_id`、caption、`name="document"`、文件名和文件内容；
   - 正文不是 `[object FormData]`。
3. 贴纸发送显式声明 `kind: animation`。Telegram 映射为 `sendAnimation`，QQ 映射为图片消息，微信保持原媒体发送行为。
4. Windows 上保存 PNG/JPG 为贴纸不再依赖 macOS `sips`；`scripts/normalize-sticker-gif.js` 改用直接依赖 `sharp` 生成 240×240 透明背景 GIF。
5. 显式 `channelId` 现在优先于当前 turn 通道。跨端发送不复用其他端的地址，而是通过 identity map 把 canonical sender ID 解析为目标端的 Telegram chat ID 或 QQ user ID；缺少绑定时明确失败。
6. 后台或延迟主动投递的 binding 目标解析同时支持 Telegram 与 QQ，不再只有 Telegram 专用分支。
7. `cyberboss_sticker_send` 的工具描述不再写死“当前微信聊天”，改为当前 Cyberboss thread 对应的聊天。

### 验证边界

- 文件服务、Telegram、QQ、贴纸相关测试共 44 项通过。
- `npm run check` 通过。
- 本地真实代理 multipart 回归通过；未向真实 Telegram 或 QQ 账号发送测试文件，避免产生未经确认的外部消息。
- 全仓库测试仍存在与本次修改无关的既有 Windows 路径断言和旧测试 mock 缺失；因此不能把“全仓库测试全部通过”列为本次证据。

### 当前通信语义

- 当前聊天内发送：使用当前 turn 的精确 `channelId + externalUserId + contextToken`。
- 显式跨端发送：使用 `channelId` 选通道，用 identity map 找目标端真实地址。
- Telegram 失败不会静默回落到微信或 QQ。
- QQ 当前文件能力限于私聊；普通文件上传依赖 NapCat Docker 共享目录配置。
- 入站附件的持久化仍由主应用按 Telegram、QQ、微信分别分派，尚未下沉为完全插件化的 adapter 契约。
