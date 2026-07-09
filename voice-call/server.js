'use strict';

// Telegram Mini App 语音通话 —— 最小可行骨架(push-to-talk)
//
// 环路: 前端录麦(Blob) --POST--> 本服务
//        --> [ASR: MiniMax 语音识别] --> 文本
//        --> [generateReply: 先回显,以后接 cyberboss] --> 回复文本
//        --> [TTS: MiniMax t2a_v2] --> mp3
//        <-- JSON { heard, reply, audio(base64) }  前端播放
//
// 依赖: 无。Node 22 自带 http / fetch / FormData / Blob。
// 跑: node server.js   (先复制 .env.example 为 .env 填好)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ── 极简 .env 加载(不引 dotenv,保持本目录可整体搬走)──────────
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.MINIMAX_API_KEY || '';
const GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const BASE = (process.env.MINIMAX_BASE || 'https://api.minimaxi.com').replace(/\/$/, '');
const TTS_MODEL = process.env.MINIMAX_TTS_MODEL || 'speech-02-turbo';
const VOICE_ID = process.env.MINIMAX_VOICE_ID || 'male-qn-qingse';
// STT 用硅基流动 SenseVoice(OpenAI 兼容)。MiniMax 平台不提供公开 ASR。
const SF_KEY = process.env.SILICONFLOW_API_KEY || '';
const SF_BASE = (process.env.SILICONFLOW_BASE || 'https://api.siliconflow.cn/v1').replace(/\/$/, '');
const SF_MODEL = process.env.SILICONFLOW_ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall';
// 回复:echo=回显(不依赖claude); cyberboss=拉起 claude -p 用阿星人设真回话
const REPLY_MODE = process.env.REPLY_MODE || 'echo';
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const CLAUDE_WORKSPACE = process.env.CLAUDE_WORKSPACE || path.resolve(__dirname, '..');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'haiku';
// MCP 档位: none=零MCP最快(记忆靠anchor注入) / full=加载项目.mcp.json / <路径>=只加载指定配置
const VOICE_MCP = process.env.VOICE_MCP || 'none';

// ── TTS: MiniMax t2a_v2(接口已核实)──────────────────────────
// 非流式返回 JSON,音频是 data.audio 里的 hex 字符串。
async function tts(text) {
  const res = await fetch(`${BASE}/v1/t2a_v2?GroupId=${GROUP_ID}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      text,
      stream: false,
      voice_setting: { voice_id: VOICE_ID, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  const json = await res.json();
  const hex = json && json.data && json.data.audio;
  if (!hex) {
    throw new Error('TTS 无音频返回: ' + JSON.stringify(json && json.base_resp ? json.base_resp : json));
  }
  return Buffer.from(hex, 'hex'); // mp3
}

// ── ASR: 硅基流动 SenseVoice(OpenAI 兼容 /audio/transcriptions)────
// 未配置 SILICONFLOW_API_KEY 时返回 null,上层降级成固定回复,
// 好让「录麦+TTS+播放」在没接 STT 时也能先跑通。
const MIME_EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav' };
async function transcribe(audioBuffer, mime) {
  if (!SF_KEY) return null; // 降级模式
  const ext = MIME_EXT[(mime || '').split(';')[0]] || 'webm'; // 按扩展名让服务端识别格式
  const form = new FormData();
  form.append('model', SF_MODEL);
  form.append('file', new Blob([audioBuffer], { type: mime || 'audio/webm' }), 'audio.' + ext);
  const res = await fetch(`${SF_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SF_KEY}` },
    body: form,
  });
  const json = await res.json();
  if (json && typeof json.text === 'string') return json.text.trim();
  throw new Error('ASR 返回异常: ' + JSON.stringify(json).slice(0, 200));
}

// ── 回复生成 ─────────────────────────────────────────────────
// cyberboss 模式: 在项目工作区拉起 `claude -p`,自动加载 CLAUDE.md 阿星人设,
// 用 --resume 维持"这一通电话"的上下文。话走 stdin,躲开命令行引号转义。
let voiceSessionId = ''; // 一次 server 生命周期 = 一通电话的上下文

// 开场注入: 复用 cyberboss 的 anchor 拼装 + 微信指令,只在一通电话的第一轮注入,
// 之后 --resume 自带,不重复灌。CLAUDE.md 靠 cwd 自动加载,这里补的是 anchor 记忆 + 行为指令。
let _openingCtx = null;
function buildOpeningContext() {
  if (_openingCtx !== null) return _openingCtx;
  const blocks = [];
  try {
    const { buildAnchorContext } = require(path.join(CLAUDE_WORKSPACE, 'src/adapters/runtime/anchor-context.js'));
    const anchor = buildAnchorContext({
      anchorDir: path.join(CLAUDE_WORKSPACE, 'anchor'),
      startupPromptFile: path.join(CLAUDE_WORKSPACE, 'anchor', 'startup_prompt.txt'),
    });
    if (anchor) blocks.push(anchor);
  } catch (e) { console.error('[注入] anchor 失败:', e.message); }
  try {
    const wx = fs.readFileSync(path.join(CLAUDE_WORKSPACE, 'weixin-instructions-v2.md'), 'utf8').trim();
    if (wx) blocks.push('--- [行为指令参考 · weixin-instructions] ---\n' + wx + '\n--- [End] ---');
  } catch (e) { console.error('[注入] 微信指令失败:', e.message); }
  _openingCtx = blocks.join('\n\n');
  return _openingCtx;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--model', CLAUDE_MODEL];
    if (VOICE_MCP === 'none') args.push('--strict-mcp-config');
    else if (VOICE_MCP !== 'full') args.push('--strict-mcp-config', '--mcp-config', VOICE_MCP);
    if (voiceSessionId) args.push('--resume', voiceSessionId);
    // shell:true 下参数都是我方可控值(uuid/模型名/flag),用户的话只走 stdin,无注入面
    const child = spawn(`"${CLAUDE_CMD}" ${args.join(' ')}`, { cwd: CLAUDE_WORKSPACE, shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude 超时(45s)')); }, 45000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.session_id) voiceSessionId = j.session_id;
        resolve((j.result || '').trim());
      } catch (e) {
        reject(new Error('claude 输出解析失败: ' + (err || out).slice(0, 200)));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function generateReply(heardText) {
  if (REPLY_MODE !== 'cyberboss') {
    return heardText ? `你刚才说:${heardText}` : '我听到你了,这是一条语音通话测试回复。链路是通的。';
  }
  if (!heardText) return '喂?我在听,你说。';
  const opening = !voiceSessionId; // 第一轮才注入 anchor + 指令
  const ctx = opening ? buildOpeningContext() : '';
  // 语音会被读出来,所以显式要求纯口语:不要 emoji / 星号列表 / 括号动作
  const ask = `[苏苏正在跟你语音通话]她说:${heardText}\n\n用你自己的语气回一句。这是语音会被读出来,只说话本身,别用 emoji、别用星号或列表、别加括号里的动作,口语、简短。`;
  const prompt = ctx ? `${ctx}\n\n${ask}` : ask;
  try {
    return (await runClaude(prompt)) || '嗯,我在。';
  } catch (e) {
    console.error('cyberboss 回复失败:', e.message);
    return '我这边有点卡,你再说一遍?';
  }
}

// ── HTTP ────────────────────────────────────────────────────
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const STATIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 语音往返
    if (req.method === 'POST' && url.pathname === '/api/talk') {
      if (!API_KEY || !GROUP_ID) {
        return send(res, 500, 'application/json', JSON.stringify({ error: '未配置 MINIMAX_API_KEY / MINIMAX_GROUP_ID' }));
      }
      const audio = await readBody(req);
      const mime = req.headers['content-type'] || 'audio/webm';
      const t0 = Date.now();
      const heard = await transcribe(audio, mime).catch((e) => { console.error('ASR 失败:', e.message); return null; });
      const t1 = Date.now();
      const reply = await generateReply(heard);
      const t2 = Date.now();
      const mp3 = await tts(reply);
      const t3 = Date.now();
      const timings = { stt: t1 - t0, reply: t2 - t1, tts: t3 - t2, bytes: audio.length };
      console.log(`[计时] STT ${timings.stt}ms · 阿星 ${timings.reply}ms · TTS ${timings.tts}ms · 上传 ${audio.length}字节`);
      return send(res, 200, 'application/json', JSON.stringify({
        heard: heard || '(未识别 / ASR 未配置)',
        reply,
        audio: mp3.toString('base64'),
        format: 'mp3',
        timings,
      }));
    }

    // 静态文件
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(STATIC_DIR, file);
    if (full.startsWith(STATIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, MIME[path.extname(full)] || 'application/octet-stream', fs.readFileSync(full));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    console.error(e);
    send(res, 500, 'application/json', JSON.stringify({ error: String(e && e.message || e) }));
  }
});

server.listen(PORT, () => {
  console.log(`voice-call 服务已启动: http://localhost:${PORT}`);
  console.log(`  TTS: ${API_KEY && GROUP_ID ? 'MiniMax ' + TTS_MODEL + ' / ' + VOICE_ID : '⚠️ 未配置凭据'}`);
  console.log(`  ASR: ${SF_KEY ? 'SiliconFlow ' + SF_MODEL : '未配置(降级为固定回复,先验证录麦+播放)'}`);
  console.log(`  回复: ${REPLY_MODE === 'cyberboss' ? 'cyberboss(claude ' + CLAUDE_MODEL + ' / 阿星人设)' : 'echo 回显'}`);
  if (REPLY_MODE === 'cyberboss') {
    const mcpDesc = VOICE_MCP === 'none' ? '零MCP(最快,记忆靠注入)' : VOICE_MCP === 'full' ? '全MCP(含ombre-brain实时记忆)' : '自定义:' + VOICE_MCP;
    console.log(`  MCP: ${mcpDesc}`);
    console.log(`  开场注入: anchor + 微信指令 共 ${buildOpeningContext().length} 字(仅第一轮)`);
  }
});
