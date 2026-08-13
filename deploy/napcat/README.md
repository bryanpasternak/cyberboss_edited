# Cyberboss 本地 NapCat

此目录用于 Windows Docker Desktop。QQ 登录数据、NapCat 配置和媒体共享目录都写入被 Git 忽略的 `data/`。

## 启动

在 PowerShell 中执行：

```powershell
Set-Location C:\Users\19670\cyberboss\deploy\napcat
Copy-Item .env.example .env
docker compose pull
docker compose up -d
docker compose logs -f --tail=100
```

首次扫码成功后，在 `.env` 中填写机器人 QQ 号，再执行：

```powershell
docker compose up -d --force-recreate
```

## OneBot 设置

打开 `http://127.0.0.1:6099/webui`，创建 WebSocket 服务端：

- Host：`0.0.0.0`
- Port：`3001`
- 消息格式：`array`
- 上报自身消息：关闭
- 心跳：`30000`
- Token：使用随机字符串，并与 Cyberboss 的 `CYBERBOSS_QQ_ACCESS_TOKEN` 保持一致

Cyberboss `.env` 示例：

```env
CYBERBOSS_CHANNELS=weixin,telegram,qq
CYBERBOSS_QQ_WS_URL=ws://127.0.0.1:3001
CYBERBOSS_QQ_ACCESS_TOKEN=OneBot中设置的Token
CYBERBOSS_QQ_SELF_ID=机器人QQ号
CYBERBOSS_QQ_ALLOWED_USER_IDS=你的QQ号
CYBERBOSS_QQ_MEDIA_HOST_DIR=C:\Users\19670\cyberboss\deploy\napcat\data\plugins
CYBERBOSS_QQ_MEDIA_CONTAINER_DIR=/app/napcat/plugins
CYBERBOSS_QQ_MEDIA_BASE64_MAX_BYTES=2097152
```

端口只映射到 `127.0.0.1`。普通文件与大图片会临时复制到 `data/plugins/outbox/`；代码会清理超过 24 小时的旧文件。
