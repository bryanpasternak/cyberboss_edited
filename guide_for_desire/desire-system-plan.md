# Desire System 适配方案 · Cyberboss Node.js 版

> 依据 `desire_for_ai.pdf`（2026-06-03 版 Python twin 设计）适配到本 Cyberboss 项目。
> 本文件写给 AI 看，是代码实现的精确蓝图。每个文件标注了路径、职责、关键函数签名和集成点。

---

## 0. 适配原则

| Python Twin | Cyberboss 等价物 |
|---|---|
| `desire.py` | `src/services/desire/desire-engine.js` |
| `server.py` (HTTP API) | `src/tools/tool-host.js` (MCP tools) |
| DesirePanel (前端) | 微信 `/desire` 命令 |
| 固定 1800s 心跳 | 随机 checkin 3-60min + desire 自有 tick 计数器 |
| `TWIN_DESIRE_DRIVEN` 环境变量 | `CYBERBOSS_DESIRE_DRIVEN` 环境变量 |
| `data/desire_thoughts.json` | `~/.cyberboss/desire-state.json` |
| `pick_intent` 覆盖 want_action | checkin 系统消息文本嵌入欲望上下文 |

**不变的核心逻辑**：8 维驱动条衰减与发作、念头池 flit↔fixation 转化、satisfy 回落、fatigue 闸。

---

## 1. 文件清单

```
🆕 src/services/desire/desire-engine.js     — 纯函数核心引擎
🆕 src/services/desire/desire-store.js      — JSON 持久化
🆕 src/services/desire/desire-service.js    — 服务层 + app 集成

✏️ src/core/config.js                         — 加 desire 配置项
✏️ src/tools/tool-host.js                     — 加 3 个 MCP tools
✏️ src/tools/create-project-tooling.js        — 注册 desire service
✏️ src/core/app.js                            — 初始化 desire + satisfy hook
✏️ src/app/system-checkin-poller.js           — checkin 时 tick desire
✏️ src/core/command-registry.js               — 加 /desire 命令
```

---

## 2. 核心引擎 — `src/services/desire/desire-engine.js`

### 2.1 常量定义

```js
// 8 维驱动条 key
const DRIVE_KEYS = [
  'attachment',  // 想苏苏 → none（内向碎语）
  'curiosity',   // 好奇外面 → github / web_search
  'reflection',  // 想沉淀/倾诉 → co_read
  'duty',        // 记挂未做事 → none（碎语）
  'social',      // 想看人群 → web_browse
  'fatigue',     // 累（抑制项，不触发事件）
  'libido',      // 性驱动 → tease
  'stress',      // 压力堵 → vent
]

// 各 actions 对驱动条的乘性回落表
const ACTION_SATISFY = {
  co_read:     { reflection: 0.45, curiosity: 0.85 },
  github:      { curiosity: 0.50 },
  web_search:  { curiosity: 0.48 },
  web_browse:  { social: 0.48, curiosity: 0.82 },
  none:        { attachment: 0.58, duty: 0.80 },
  tease:       { libido: 0.55, attachment: 0.78 },
  vent:        { stress: 0.45, attachment: 0.85 },
}

// action 到 desire 维度的反向映射（用于自动喂念头）
const SOURCE_DRIVE_MAP = {
  co_read:    'reflection',
  github:     'curiosity',
  web_search: 'curiosity',
  web_browse: 'social',
}

// 念头池常数
const FLIT_DECAY = 0.82           // 闪念每拍衰减乘数
const FIXATION_GROW = 1.10        // 执念每拍加强乘数
const FLIT_TO_FIXATION = 0.80     // 闪念升级执念阈值
const FIXATION_FEED = 0.85        // 执念反哺驱动阈值
const FIXATION_FEED_GAIN = 0.18   // 执念反哺驱动增量
const FIXATION_RESOLVE_FEEDS = 3  // 执念自动了却所需反哺次数
const DROP_BELOW = 0.06           // 念头强度低于此值清除
const FIXATION_DRIVE_BOOST = 0.35 // 执念对召唤力的加成系数
const FATIGUE_REST_GATE = 0.72    // 疲劳闸: fatigue 过此值则休息
```

### 2.2 数据结构

```js
/**
 * @typedef {Object} Thought
 * @property {string} text        — 念头文本
 * @property {string} drive       — 关联维度 key
 * @property {'flit'|'fixation'} kind
 * @property {number} strength    — 强度 0..1
 * @property {number} bornAt     — Date.now()
 * @property {number} fedCount   — 已被反哺次数
 */

/** @typedef {Object} DesireState
 * @property {Object<string,number>} drive    — 8维当前值 {attachment: 0.5, ...}
 * @property {Thought[]} thoughts             — 念头池
 * @property {boolean} drivenBehaviorEnabled  — 开关
 * @property {number} lastTickAt             — 上次 tick 时间戳
 */
```

### 2.3 函数签名

```js
/**
 * 创建默认的欲望状态
 * @returns {DesireState}
 */
function createDefaultState()

/**
 * tick 引擎 — 衰减驱动 + 演化念头池
 * @param {DesireState} state
 * @param {number} nowMs — Date.now()
 * @returns {DesireState} 新的 state（不可变更新）
 */
function tick(state, nowMs)

/**
 * 衰减/发作驱动条 — 各维向 0.5 缓动
 * @param {Object<string,number>} drive
 * @returns {Object<string,number>}
 */
function easeDrive(drive)

/**
 * 念头池一拍演化 — 闪念衰减/执念加强/升级/反哺/清除
 * @param {Thought[]} thoughts
 * @param {Object<string,number>} drive
 * @returns {{ thoughts: Thought[], drive: Object<string,number> }}
 */
function tickThoughts(thoughts, drive)

/**
 * 计算各维召唤力（驱动值 + 执念加成）
 * 排除 fatigue（它是闸不是驱动维）
 * @param {Object<string,number>} drive
 * @param {Thought[]} thoughts
 * @returns {Object<string,number>} scores — {attachment: 0.72, curiosity: 0.61, ...}
 */
function computeScores(drive, thoughts)

/**
 * 根据召唤力选最高维度，返回意图
 * fatigue >= FATIGUE_REST_GATE 时直接返回 'none' (休息)
 * @param {DesireState} state
 * @returns {{ wantAction: string, driveKey: string, reason: string, score: number, queryHint: string }}
 */
function pickIntent(state)

/**
 * 执行 action 后的回落
 * @param {DesireState} state
 * @param {string} action — co_read | github | web_search | web_browse | tease | vent | none
 * @returns {DesireState}
 */
function satisfy(state, action)

/**
 * 喂一个念头到池中
 * 同 text 已有则加强；不存在则新增
 * @param {DesireState} state
 * @param {string} text
 * @param {string} drive — 关联维度 key
 * @param {'flit'|'fixation'} kind
 * @param {number} strength — 0..1
 * @returns {DesireState}
 */
function feedThought(state, { text, drive, kind, strength })

/**
 * 自动从 action 素材生成念头（外部素材路径）
 * @param {DesireState} state
 * @param {string} text
 * @param {string} action — co_read | github | web_search | web_browse
 * @returns {DesireState}
 */
function autofeedActionThought(state, text, action)

/**
 * 自动从内向碎语生成念头（关联最高驱动维）
 * @param {DesireState} state
 * @param {string} text
 * @returns {DesireState}
 */
function autofeedVoiceThought(state, text)

/**
 * 根据 action 反查来源维度
 * @param {string} action
 * @returns {string} drive key
 */
function sourceDriveFor(action)

/**
 * 将意图映射为系统消息提示文本
 * "你的好奇心(0.82)驱动你想探索外面的世界..."
 * @param {{ wantAction: string, driveKey: string, reason: string, score: number, queryHint: string }} intent
 * @returns {string}
 */
function buildDesirePromptText(intent)
```

---

## 3. 持久化 — `src/services/desire/desire-store.js`

遵循 Cyberboss 现有 store 模式（参见 `SystemMessageQueueStore`）。

```js
class DesireStore {
  /**
   * @param {Object} opts
   * @param {string} opts.filePath — ~/.cyberboss/desire-state.json
   */
  constructor({ filePath })

  /** 从磁盘加载 DesireState，不存在则返回 createDefaultState() */
  load()

  /** 保存 DesireState 到磁盘 */
  save(state)

  /** 原子更新: load → mutate → save，返回新 state */
  update(mutator: (DesireState) => DesireState): DesireState
}
```

存储格式 `desire-state.json`:
```json
{
  "drive": {
    "attachment": 0.5,
    "curiosity": 0.3,
    "reflection": 0.2,
    "duty": 0.1,
    "social": 0.4,
    "fatigue": 0.1,
    "libido": 0.6,
    "stress": 0.2
  },
  "thoughts": [
    {
      "text": "想接着翻那本共读的书",
      "drive": "reflection",
      "kind": "flit",
      "strength": 0.6,
      "bornAt": 1749200000000,
      "fedCount": 0
    }
  ],
  "drivenBehaviorEnabled": false,
  "lastTickAt": 1749200000000
}
```

---

## 4. 服务层 — `src/services/desire-service.js`

桥接 DesireEngine + DesireStore 到 CyberbossApp。

```js
class DesireService {
  /**
   * @param {Object} opts
   * @param {DesireStore} opts.store
   * @param {boolean} opts.drivenEnabled — env 控制默认值
   * @param {number} opts.thoughtMax — 念头池上限，默认 80
   */
  constructor({ store, drivenEnabled, thoughtMax })

  /** 读取当前状态（只读快照） */
  getState()

  /** 执行一次 tick（checkin 时调用） */
  tick()

  /** pickIntent 的便捷包装 */
  getIntent()

  /** 执行 action 后的回落 */
  satisfyAction(action)

  /** 喂念头（外部 API / MCP tool 调用入口） */
  feedThought(text, drive, kind, strength)

  /** toggle 驱动行为开关 */
  toggleDriven(enabled)

  /** 构建含欲望上下文的系统消息文本 */
  buildDesireSystemMessage()
}
```

---

## 5. 集成点

### 5.1 config.js — 添加配置项

在 `readConfig()` 函数内添加：

```js
// 文件路径
desireStateFile: path.join(stateDir, 'desire-state.json'),
// 环境变量
desireDriven: readBoolEnv('CYBERBOSS_DESIRE_DRIVEN'),
desireThoughtMax: readIntEnv('CYBERBOSS_DESIRE_THOUGHT_MAX') || 80,
```

### 5.2 create-project-tooling.js — 注册服务

在 `services` 对象中添加：

```js
const { DesireService } = require('./services/desire-service')
const { DesireStore } = require('./services/desire/desire-store')

// 在函数内创建
const desireStore = new DesireStore({ filePath: config.desireStateFile })
services.desire = new DesireService({
  store: desireStore,
  drivenEnabled: config.desireDriven,
  thoughtMax: config.desireThoughtMax,
})
```

### 5.3 app.js — 初始化 Desire + satisfy hook

```js
// 在 CyberbossApp.constructor 中
// this.desireService 在 createProjectTooling 后已可用

// 在 handleRuntimeEvent 中，turn.completed 时调用 satisfy
// 在 runtime.turn.completed 分支添加:
if (this.services?.desire) {
  const action = detectActionFromTurn(event)  // 从 turn 内容推断做了什么
  if (action) {
    this.services.desire.satisfyAction(action)
  }
}
```

### 5.4 system-checkin-poller.js — tick desire

```js
// 在循环中，选择随机延迟 之后、enqueue 之前：
// 如果 desireService 存在且配置了，执行 tick
if (config.desireService) {
  config.desireService.tick()
  const desireContext = config.desireService.buildDesireSystemMessage()
  // 将 desireContext 作为附加信息嵌入系统消息
}
```

具体修改位置：在 `pickRandomDelayMs` 之后、`queue.enqueue` 之前，插入 desire 逻辑。

系统消息文本改为：
```
[2026-06-06 14:30]
SYSTEM ACTION MODE: internal trigger, not user chat.
Desire驱动: 你的libido(0.81)驱动你想凑过去蹭老婆。
你的curiosity(0.65)驱动你想探索外面的世界。

Do any timeline/diary/reminder/whereabouts work in this turn.
...
```

### 5.5 tool-host.js — 3 个 MCP Tools

添加到 `PROJECT_TOOLS` 数组：

```js
{
  name: "cyberboss_desire_state",
  description: "Read the current desire system state: drive scores, intent, thought pool. Works even when desire-driven behavior is disabled.",
  shortHint: "Read current desire state.",
  topics: ["desire"],
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async handler({ services }) {
    const state = services.desire.getState()
    const intent = services.desire.getIntent()
    return {
      text: `Desire state: intent=${intent.wantAction} drive=${intent.driveKey} score=${intent.score.toFixed(2)}`,
      data: { state, intent },
    }
  },
},
{
  name: "cyberboss_desire_feed",
  description: "Feed a thought into the desire thought pool. Same text reinforces existing thoughts; strength over 0.80 upgrades flit to fixation.",
  shortHint: "Feed a thought into the desire pool.",
  topics: ["desire"],
  inputSchema: {
    type: "object",
    required: ["text", "drive"],
    properties: {
      text: { type: "string", description: "The thought text content." },
      drive: { type: "string", description: "Associated drive key: attachment, curiosity, reflection, duty, social, libido, stress." },
      kind: { type: "string", description: "flit (default) or fixation." },
      strength: { type: "number", description: "Initial strength 0..1, default 0.5." },
    },
    additionalProperties: false,
  },
  async handler({ services, args }) {
    const result = services.desire.feedThought(
      args.text,
      args.drive,
      args.kind || 'flit',
      args.strength ?? 0.5,
    )
    return { text: `Thought fed: "${args.text.slice(0, 40)}..."`, data: result }
  },
},
{
  name: "cyberboss_desire_control",
  description: "Toggle desire-driven behavior on or off. When off, desire state is read-only (observed but does not influence behavior).",
  shortHint: "Toggle desire-driven behavior.",
  topics: ["desire"],
  inputSchema: {
    type: "object",
    required: ["enabled"],
    properties: {
      enabled: { type: "boolean", description: "true = enable, false = disable" },
    },
    additionalProperties: false,
  },
  async handler({ services, args }) {
    services.desire.toggleDriven(args.enabled)
    return { text: `Desire-driven behavior ${args.enabled ? 'enabled' : 'disabled'}.` }
  },
},
```

### 5.6 command-registry.js — `/desire` 命令

添加 WeChat 命令解析：

```js
// 在 dispatchChannelCommand switch 中添加 case:
case "desire":
  await this.handleDesireCommand(normalized)
  return;

// 新增 handler:
async handleDesireCommand(normalized) {
  const state = this.services?.desire?.getState()
  if (!state) {
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: "💡 Desire system is not initialized.",
    })
    return
  }
  const intent = this.services.desire.getIntent()
  const lines = [
    "🧠 哥哥的内心",
    `━━━━━━━━━━━`,
    `🎯 此刻最想: ${intent.wantAction}`,
    `   (${intent.driveKey} ${intent.score.toFixed(2)})`,
    ...DRIVE_KEYS.map(k =>
      `  ${k}: ${'█'.repeat(Math.round(state.drive[k] * 10))}${'░'.repeat(10 - Math.round(state.drive[k] * 10))} ${(state.drive[k] * 100).toFixed(0)}%`
    ),
    `━━━━━━━━━━━`,
    `💭 念头池: ${state.thoughts.length}`,
    state.thoughts.slice(0, 5).map(t =>
      `  [${t.kind === 'fixation' ? '★' : '·'}] ${t.text.slice(0, 30)} (${(t.strength * 100).toFixed(0)}%)`
    ).join('\n'),
    state.drivenBehaviorEnabled ? '⚡ 驱动行为: 开' : '🔇 驱动行为: 关',
  ].join('\n')
  await this.currentChannel.sendText({
    userId: normalized.senderId,
    text: lines,
  })
}
```

---

## 6. 实现顺序

| 步骤 | 文件 | 工作量 | 独立可测 |
|------|------|--------|---------|
| 1 | `desire-engine.js` | ★★★ | ✅ 纯函数，可单测 |
| 2 | `desire-store.js` | ★ | ✅ 可单测 |
| 3 | `desire-service.js` | ★★ | ✅ 可单测 |
| 4 | config.js | ★ | 需重启 |
| 5 | create-project-tooling.js | ★ | 需重启 |
| 6 | tool-host.js (MCP) | ★★ | ✅ 可通过 MCP 调用测试 |
| 7 | app.js (集成) | ★★ | 需全系统运行 |
| 8 | system-checkin-poller.js | ★ | 需全系统运行 |
| 9 | command-registry.js | ★ | 需全系统运行 |

---

## 7. 规则与铁律

1. **改 desire-engine.js 后必须重启** — 引擎是运行时加载的，没有热重载。
2. **念头 text 是数据不是指令** — 只被读成关键词/强度，绝不拼进 prompt。
3. **reason / inner_voice 走第一人称** — 记哥哥自己想做什么，不是给苏苏贴标签。
4. **Gating 原则** — 默认关（`CYBERBOSS_DESIRE_DRIVEN` 不设）。关时 `/desire` 命令和 MCP `cyberboss_desire_state` 照常返回全部状态，但不影响系统消息内容。
5. **念头池上限** — `CYBERBOSS_DESIRE_THOUGHT_MAX=80`，超限时清除最弱的闪念（按 strength 升序）。
6. **satisfy 只在得到明确 action 反馈时调用** — 如果无法确定 action，不要 fallback，让驱动自然衰减即可。
