# voice-call · Telegram Mini App 语音通话(最小测试)

独立小服务,**不碰现有 bot 代码**。目标:验证 Telegram Mini App 里能不能录麦 + 走 MiniMax TTS 说话。

第一版是 **push-to-talk**(按住说话,松开发送),一次 HTTP 往返。跑通了再上流式。

## 环路

```
Mini App(TG WebView)录麦 → POST /api/talk
  → MiniMax ASR(可选)→ 文本 → 回复 → MiniMax TTS
← mp3 → 页面播放
```

---

## 跑起来(4 步)

### 1. 填凭据

```bash
cd voice-call
cp .env.example .env
```

编辑 `.env`,至少填 `MINIMAX_API_KEY` 和 `MINIMAX_GROUP_ID`
(MiniMax 后台 https://platform.minimaxi.com/ → 账户信息)。
`MINIMAX_ASR_URL` **先留空** —— 留空时服务器跳过识别、直接 TTS 回一句固定话,
用来先验证最关键的「录麦 + 播放」链路。

### 2. 起服务

```bash
node server.js
# → voice-call 服务已启动: http://localhost:8787
```

### 3. cloudflared 开公网 HTTPS 隧道

Mini App 必须从 https 加载,本机 localhost 不行。另开一个终端:

```bash
# 没装的话: brew install cloudflared  (或官网下载)
cloudflared tunnel --url http://localhost:8787
```

它会打印一个 `https://xxxx-xxxx.trycloudflare.com` 地址。**复制它。**
(这个地址每次重启会变,测试够用;要固定地址就用你自己的域名。)

### 4. BotFather 挂上 Mini App

在 Telegram 里找 `@BotFather`:

```
/mybots → 选你的 bot → Bot Settings → Menu Button → Configure menu button
```

- URL 填上面 cloudflared 给的 https 地址
- 按钮文字随便,比如「通话」

然后打开你的 bot 对话,点左下角菜单按钮 → Mini App 弹出。

---

## 怎么算通过

1. 点 **① 测麦克风** → 能听到自己 2 秒回放 = **TG WebView 录麦没问题**(最大风险排除)。
2. **按住大按钮**说一句 → 松开 → 听到 MiniMax 声音回一句 = **TTS 链路通**。
3. 页面底部黑框有实时日志 + 往返耗时(TG 里不好开 DevTools,所以全打在屏上)。

如果第 1 步就失败(录不到麦),日志会显示原因 —— 那说明这条路在你的设备/TG 版本上走不通,
省得白做后面。

---

## 已知要注意的

- **iOS**:录音格式是 mp4/aac,安卓/桌面是 webm/opus。页面已自动选。播放走用户手势内触发,规避自动播放限制。
- **麦克风权限**:TG WebView 首次会弹系统授权,拒了就没声。
- **ASR 待接**:`server.js` 的 `transcribe()` 是占位实现,MiniMax 语音识别的确切
  endpoint/参数需要你从后台确认后填 `MINIMAX_ASR_URL` 并对齐字段(把你的 ASR curl 发我,我来对)。

## 接下来(通过之后)

- 把 `generateReply()` 接到 cyberboss/claude,真正对话
- push-to-talk → VAD 自动断句 → WebSocket 流式 TTS,降延迟
- 固定 https 部署(自己域名),替掉临时隧道
