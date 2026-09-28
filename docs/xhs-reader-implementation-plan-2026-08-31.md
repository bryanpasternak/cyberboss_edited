# Cyberboss 小红书图文与视频读取工具实现方案

日期：2026-08-31

## 目标

在 Cyberboss 项目工具中增加 `cyberboss_xhs_read`。当聊天里出现小红书分享链接时，agent 可以调用该工具取得笔记正文、作者、互动数据、配图，以及视频的有序抽帧文件路径，再使用当前运行时已有的本地读图能力逐张查看。

第一版服务于本机 Cyberboss，不建设网页预览卡、图片代理接口或公开 MCP 服务，也不修改微信、Telegram、QQ 的消息传输链路。

## 现有接入点

- `src/tools/tool-host.js`：注册 agent 可见的 `cyberboss_xhs_read` 工具。
- `src/tools/create-project-tooling.js`：创建并注入小红书读取服务。
- `src/core/config.js`：从环境变量生成缓存、超时、大小限制和 ffmpeg 路径配置。
- Codex 运行时已经支持本地图片路径；Claude Code 也可以用文件读取工具查看图片。
- 当前 Cyberboss MCP 会把工具结果序列化为文本。第一版返回结构化 JSON 和本地绝对路径，不改写 MCP 图片内容块协议。

## 数据流

1. 校验输入链接，只接受 HTTPS/HTTP 的小红书页面域名。
2. 使用 iPhone Safari User-Agent 发起请求，关闭自动重定向，并在每一次跳转前重新校验协议、域名和解析后的 IP。
3. 限量读取 HTML，从 `window.__INITIAL_STATE__` 赋值中提取平衡的对象文本。
4. 在字符串之外把裸 `undefined` 规范化为 `null`，再使用 `JSON.parse`；禁止 `eval`、`Function` 和执行页面脚本。
5. 从多个候选路径读取笔记对象，整理标题、正文、作者、互动数据、配图和视频 URL。
6. 下载配图到缓存目录。视频存在且 ffmpeg/ffprobe 可用时，下载视频并均匀抽帧。
7. 把笔记数据、图片和视频帧的有序绝对路径返回给 agent。agent 必须按 `index` 顺序查看文件。

## 工具接口

输入：

```json
{
  "url": "https://xhslink.com/...",
  "refresh": false
}
```

输出的主要字段：

```json
{
  "sourceUrl": "...",
  "finalUrl": "...",
  "note": {
    "title": "...",
    "text": "...",
    "author": { "name": "...", "id": "..." },
    "interactions": { "liked": 0, "collected": 0, "comments": 0 }
  },
  "images": [
    { "index": 1, "url": "...", "absolutePath": "..." }
  ],
  "videoFrames": [
    { "index": 1, "timestampSeconds": 4, "absolutePath": "..." }
  ],
  "videoProcessing": {
    "status": "completed"
  },
  "cache": { "hit": false, "expiresAt": "..." }
}
```

`videoProcessing.status` 使用稳定的机器可读值：

- `not_applicable`：不是视频笔记。
- `completed`：视频抽帧成功。
- `ffmpeg_unavailable`：未安装或找不到 ffmpeg/ffprobe。
- `video_too_large`：视频超过限制。
- `video_processing_failed`：视频下载、探测或抽帧失败；正文和已下载图片仍可用。

## 缓存与清理

- 默认目录：`<CYBERBOSS_STATE_DIR>/xhs-cache`。
- 默认 TTL：6 小时。
- 输入 URL 的 SHA-256 作为缓存键；每项包含 manifest、图片、可选视频和帧。
- 先写随机 staging 目录，成功后再原子替换目标缓存目录。
- 过期项在命中检查和新读取时做受限清理；任何递归删除都必须先确认目标位于缓存根目录内。
- `refresh=true` 跳过有效缓存并重新抓取。

## 安全边界

- 页面只允许 `xhslink.com`、`xiaohongshu.com` 及其子域名。
- 媒体只允许 `xhscdn.com`、`xiaohongshu.com` 及其子域名。
- 每个初始 URL、重定向目标和资源 URL 都重新验证；拒绝非 HTTP(S)、用户名密码、IP 字面量、localhost、私网、环回、链路本地和保留地址。
- 默认最多 5 次重定向，总处理超时 60 秒。
- 默认大小限制：HTML 8 MiB、单图 25 MiB、视频 200 MiB；默认最多下载 12 张配图。
- 所有文件名由本地生成，不使用远端路径片段。
- 不提供任意 URL 代理，不把 token、Cookie 或响应头写入日志。
- 页面结构不匹配时返回明确错误，不用不完整对象冒充成功。

## 视频抽帧

- `ffprobe` 读取时长。
- 默认每 8 秒一帧，最少 4 帧、最多 8 帧。
- ffmpeg 滤镜把宽度限制在 960 px，保持比例。
- 帧文件按 `frame-01.jpg`、`frame-02.jpg` 排序，并带估算时间戳。
- 第一版不处理声音；回答时不得声称听见了视频音频。

## 需要安装的外部依赖

本次实现不自动安装系统软件。图文读取不依赖这些命令；视频抽帧需要：

- `ffmpeg`
- `ffprobe`（通常随 ffmpeg 一起安装）

Windows：

```powershell
winget install --id Gyan.FFmpeg -e
ffmpeg -version
ffprobe -version
```

macOS：

```bash
brew install ffmpeg
ffmpeg -version
ffprobe -version
```

Debian / Ubuntu：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
ffmpeg -version
ffprobe -version
```

如果命令不在 PATH，可配置：

```dotenv
CYBERBOSS_XHS_FFMPEG_PATH=C:\path\to\ffmpeg.exe
CYBERBOSS_XHS_FFPROBE_PATH=C:\path\to\ffprobe.exe
```

Node 侧使用现有 Node.js 22、内置 `fetch`、文件系统和子进程能力，不新增 npm 依赖。

## 配置

```dotenv
CYBERBOSS_XHS_CACHE_DIR=
CYBERBOSS_XHS_CACHE_TTL_MS=21600000
CYBERBOSS_XHS_TIMEOUT_MS=60000
CYBERBOSS_XHS_MAX_REDIRECTS=5
CYBERBOSS_XHS_HTML_MAX_BYTES=8388608
CYBERBOSS_XHS_IMAGE_MAX_BYTES=26214400
CYBERBOSS_XHS_VIDEO_MAX_BYTES=209715200
CYBERBOSS_XHS_MAX_IMAGES=12
CYBERBOSS_XHS_FFMPEG_PATH=ffmpeg
CYBERBOSS_XHS_FFPROBE_PATH=ffprobe
```

## 测试计划

全部自动化测试离线运行，不请求真实小红书：

- 主路径与备用路径的 `__INITIAL_STATE__` fixtures。
- 字符串里的 `undefined` 不被替换，裸值被安全转换。
- 短链多次跳转与每跳域名校验。
- 非小红书域名、IP 字面量、私网解析和非 HTTP(S) 拒绝。
- HTML、图片、视频大小限制。
- 图片清晰度选择、视频 URL 候选顺序。
- 6 小时缓存命中与 `refresh` 绕过。
- 假 ffprobe/ffmpeg 验证帧数、滤镜、排序和时间戳。
- ffmpeg 缺失时返回 `ffmpeg_unavailable`，正文和配图仍成功。
- 项目工具 schema、服务调用与返回结构。
- 相关语法检查和现有 tool-host 回归测试。

## 验收边界

完成代码和离线测试后，仍需在安装 ffmpeg 的机器上，用苏苏提供的一条有效小红书分享链接进行一次人工验收。真实页面结构、访问频率限制和 token 有效期可能变化；解析器因此保持多候选路径并给出可诊断错误，但不承诺永久绕过平台访问控制。
