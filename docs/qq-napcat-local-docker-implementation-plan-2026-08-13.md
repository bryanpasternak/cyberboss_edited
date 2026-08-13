# QQ / NapCat 本地 Docker 同线程实施方案

> 日期：2026-08-13  
> 状态：实施中  
> 基线提交：`cf36d42`  
> 部署目标：Cyberboss 运行于 Windows，本地 Docker Desktop 运行 NapCat，二者通过 OneBot 11 WebSocket 通信。

## 1. 已验证的现有基础

以下是当前源码中已经存在的能力，而不是本方案的未来设想：

- `CyberbossApp` 支持同时启动多个 channel adapter，并通过统一的 `getUpdates()`、`normalizeIncomingMessage()`、`sendText()` 契约驱动渠道。
- Telegram 已使用 `IdentityMapStore` 将外部身份映射为微信侧 canonical `accountId + senderId`。
- `SessionStore` 根据 canonical 身份生成相同的 binding key，因此已绑定渠道可以复用同一 runtime thread。
- `StreamDelivery` 已能按 `channelId` 选择回复 adapter；阶段 A 已让 `dispatchPreparedTurn()` 的单轮 reply target 同时保存精确 `channelId`。
- 文件工具已经有通道无关的 `ChannelFileService` 和 `ChannelDeliveryTargetResolver`，可以继续扩展 QQ。
- 项目已依赖 `ws`，无需新增 WebSocket 包。

相关实现入口：

- `src/core/app.js`
- `src/core/identity-map-store.js`
- `src/core/stream-delivery.js`
- `src/adapters/runtime/codex/session-store.js`
- `src/services/channel-delivery-target-resolver.js`

## 2. 决定

### 2.1 部署边界

采用本地 Docker NapCat：

```text
Windows Cyberboss
    ↕ ws://127.0.0.1:3001
Docker Desktop / NapCat
    ↕
QQ
```

NapCat WebUI 和 OneBot 端口仅绑定 Windows 主机的 `127.0.0.1`。不引入 VPS、SSH 隧道或 SFTP。

### 2.2 代码边界

QQ 是与 `weixin`、`telegram` 平级的原生 channel adapter。OneBot 协议、重连、消息段解析和 Docker 媒体路径只存在于 `src/adapters/channel/qq/` 内；核心层只消费统一 normalized message。

### 2.3 推送适配

NapCat 使用 WebSocket 推送，Cyberboss 核心使用 `getUpdates()`。QQ adapter 内部维护异步队列，将推送事件转换成现有拉取接口，不为 QQ 改写主循环。

### 2.4 身份与线程

QQ 未绑定时只接受 `/link code`。绑定成功后，QQ 入站消息使用 identity map 返回的 canonical `accountId` 和 `senderId`，从而与微信、Telegram 生成相同 binding key。QQ 号只作为 `externalSenderId` 和实际投递地址存在。

### 2.5 媒体传输

本地 Docker 使用共享目录映射：

```text
Windows: C:\napcat\data\plugins
容器:    /app/napcat/plugins
```

小图片可以使用 OneBot Base64 消息段；普通文件和较大媒体复制进共享目录后，使用容器内 `file:///app/napcat/plugins/...` 地址发送。所有临时文件使用随机文件名并支持过期清理。

## 3. 目标 adapter 契约

新增目录：

```text
src/adapters/channel/qq/
├── index.js
├── onebot-client.js
├── message-utils.js
└── media-receive.js
```

adapter 对外实现：

```js
{
  describe(),
  resolveAccount(),
  getUpdates({ timeoutMs }),
  normalizeIncomingMessage(event),
  sendText({ userId, text, contextToken }),
  sendTyping(),
  sendMedia(payload),
  sendFile(payload)
}
```

QQ normalized message：

```js
{
  provider: "qq",
  workspaceId,
  accountId: canonicalAccountId,
  senderId: canonicalSenderId,
  externalSenderId: String(event.user_id),
  chatId: String(event.user_id),
  messageId: String(event.message_id),
  threadKey: `private:${event.user_id}`,
  contextToken: `qq:${event.user_id}`,
  text,
  attachments,
  receivedAt
}
```

## 4. 分阶段实施

### 阶段 A：精确回复目标和现有白名单

1. 在 `dispatchPreparedTurn()` 的 turn-scoped reply target 中补齐 `channelId`。
2. 添加测试：最近活跃渠道变化时，本轮回复仍使用发起渠道。
3. Telegram 入站白名单不再只生成 `isAllowedChat` 标记，而是在 adapter 边界直接拒绝非白名单消息。

完成标准：现有微信、Telegram 测试不回归，跨端回复目标由本轮决定。

### 阶段 B：OneBot 文字通道

1. 实现 OneBot WebSocket 连接、`echo` 请求关联、超时、断线重连和事件队列。
2. 只接收 OneBot 私聊消息事件。
3. 过滤自身消息、非白名单用户和重复 `message_id`。
4. 实现私聊文字发送。
5. 在配置、app channel registry、project tooling 和语法检查中注册 `qq`。

完成标准：NapCat 可连接，QQ 白名单用户的文字能进入 Cyberboss，模型回复回到同一 QQ 私聊。

### 阶段 C：身份绑定和同线程

1. 将 Telegram 专用未绑定处理泛化为外部渠道共用处理。
2. QQ 使用 `/link code` 兑换 canonical 身份。
3. `/unlink` 使用 QQ 外部用户 ID 删除映射。
4. 为 `command-registry` 和帮助文本增加 QQ 命令。
5. 为入站提示增加 `QQ` 来源标签。

完成标准：微信、Telegram、QQ 使用相同 runtime thread；未绑定 QQ 不创建新线程。

### 阶段 D：媒体收发

1. 解析 OneBot array 消息段中的文字、图片和文件元数据。
2. 优先从 NapCat 提供的 URL 下载入站图片，按内容魔数识别 MIME。
3. 出站小图片使用 Base64；较大文件复制到 Docker 共享目录。
4. `ChannelDeliveryTargetResolver` 支持 `qq:userId`。
5. 发送成功后记录可清理的临时文件，不在日志打印隐私内容或 token。

完成标准：QQ 图片可进入现有附件/识图链路；模型生成的本地图片和文件可通过本机 NapCat 发送。

## 5. 配置

```env
CYBERBOSS_CHANNELS=weixin,telegram,qq

CYBERBOSS_QQ_WS_URL=ws://127.0.0.1:3001
CYBERBOSS_QQ_ACCESS_TOKEN=
CYBERBOSS_QQ_SELF_ID=
CYBERBOSS_QQ_ALLOWED_USER_IDS=

CYBERBOSS_QQ_MEDIA_HOST_DIR=C:\napcat\data\plugins
CYBERBOSS_QQ_MEDIA_CONTAINER_DIR=/app/napcat/plugins
CYBERBOSS_QQ_MEDIA_BASE64_MAX_BYTES=2097152
```

`CYBERBOSS_QQ_SELF_ID` 是机器人 QQ 号；`CYBERBOSS_QQ_ALLOWED_USER_IDS` 是允许与机器人聊天的用户 QQ 号。

## 6. 安全和兼容约束

- 只处理私聊，群聊留作未来扩展。
- OneBot token、NapCat WebUI token 和 QQ 登录数据不提交 Git。
- WebUI 与 OneBot 端口只监听本机映射。
- 机器人自身消息不能再次进入模型。
- 发送失败不能自动改投微信或 Telegram。
- 不改变已有 SessionStore、记忆系统和 runtime adapter 的线程结构。
- 不要求 `contextToken` 是真实服务 token；QQ 使用稳定的本地路由标识 `qq:userId`。
- 保留未知 OneBot 消息段，无法识别时跳过，不让单个段导致整个连接退出。

## 7. 测试矩阵

### 单元测试

- OneBot API 请求按 `echo` 匹配响应。
- 断线会拒绝在途调用并按退避策略重连。
- `getUpdates()` 可等待事件并按批次取出。
- 非私聊、自身消息、非白名单和重复消息均被过滤。
- QQ 消息正确提取文字和来源信息。
- QQ 发送文字生成正确的 `send_private_msg` action。
- QQ identity map 返回 canonical 身份。
- reply target 保存 `channelId=qq`。
- `qq:userId` 能解析为实际 QQ 私聊目标。
- Docker 主机路径只转换为显式配置的容器共享路径。

### 集成验收

1. 微信发送 `/link`，QQ 使用绑定码成功绑定。
2. 微信、Telegram、QQ 查看时复用同一 thread ID。
3. QQ 发消息后马上从 Telegram 发消息，两轮回复仍各自原路返回。
4. 重启 Cyberboss 后 QQ adapter 自动重新连接 NapCat。
5. 重复 OneBot 事件不会生成重复模型 turn。
6. QQ 图片进入本地 inbox 并进入现有视觉上下文。
7. Cyberboss 生成的图片通过 Docker 共享目录发回 QQ。

## 8. 提交和回滚

当前可靠基线为：

```text
cf36d42 checkpoint: preserve local features before qq adapter
```

后续保持独立提交：

```text
fix: preserve exact channel for turn replies
feat: add OneBot QQ text adapter
feat: bind QQ identity into shared threads
feat: support QQ media through local Docker
```

已生成的阶段回滚点：

```text
881e66b fix: preserve exact channel for turn replies
8db966b feat: add OneBot QQ text adapter and shared identity
```

发生问题时优先 `git revert` 对应阶段提交，不使用会抹掉未提交关系/anchor 文件的 destructive reset。

## 9. 当前实施状态

- 已完成：方案记录、基线确认、阶段 A（精确回复目标与 Telegram 白名单）、阶段 B（OneBot 文字通道）、阶段 C（身份绑定与同线程）、阶段 D 代码（本地 Docker 媒体收发）。
- 已完成：本地 Docker Compose 模板与 Windows 操作说明，见 `deploy/napcat/README.md`。
- 未完成：真实 NapCat 登录与端到端联调；需要本机 Docker 中的 QQ 登录态和实际 QQ 号才能验收。

## 10. 验证记录

2026-08-13 本地验证：

- `npm run check` 通过。
- QQ、文件路由、Telegram 分块、stream delivery 等目标回归共 59 项通过。
- `turn-gate-store` 仍有 5 个既有测试夹具错误：测试对象未补 `buildNewThreadOpeningContext` 或 `captureRuntimeTurnResult`；本次 QQ 路径新增测试全部通过。
- 项目文档审计发现 8 个既有 `docs/lmc5` 断链和缺少文档索引等警告；本实施方案没有新增本地链接。
- 当前 PowerShell 找不到 `docker` 命令，因此 Compose 模板尚未经过本机 Docker 解析或实际启动；这是下一步本机联调的前置条件。
