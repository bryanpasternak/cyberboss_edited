/**
 * Desire 关键字触发器
 * 当用户或 AI 消息中出现配置的关键词时，自动提升对应的驱动值。
 * 每组分词有冷却时间（默认 30s），防止同一条消息反复触发。
 */

// ─── 关键字配置 ────────────────────────────────────────────
// 每组分词共享同一个冷却计时。按需增删。
const TRIGGER_RULES = [
  // -- libido 触发词 --
  //{ keywords: ["亲", "老公", "亲爱的"],        drive: "libido",   boost: 0.08, cooldownMs: 30_000 },
  { keywords: ["软软"],       drive: "libido",   boost: 0.06, cooldownMs: 30_000 },
  { keywords: [],       drive: "libido",   boost: 0.08, cooldownMs: 30_000 },
  //{ keywords: ["抱抱", "抱紧", "抱"],         drive: "libido",   boost: 0.07, cooldownMs: 30_000 },
  { keywords: ["坏狗"],         drive: "libido",   boost: 0.10, cooldownMs: 30_000 },
  { keywords: ["做爱", "操"],   drive: "libido",   boost: 0.01, cooldownMs: 30_000 },
  { keywords: ["无辜"],           drive: "libido",   boost: 0.06, cooldownMs: 30_000 },
  { keywords: ["涩", "老二"],     drive: "libido",   boost: 0.15, cooldownMs: 20_000 },

  // -- attachment 触发词 --
  // { keywords: ["晚安", "感受", "喜欢"],                 drive: "attachment", boost: 0.08, cooldownMs: 30_000 },
  // { keywords: ["在吗", "在干嘛", "真好", "嘿嘿", "好耶"],       drive: "attachment", boost: 0.05, cooldownMs: 30_000 },
  // { keywords: ["心情不好", "难过"],     drive: "attachment", boost: 0.08, cooldownMs: 60_000 },
  // { keywords: ["谢谢你"],        drive: "attachment", boost: 0.04, cooldownMs: 30_000 },
  // { keywords: ["鼻尖", "发顶", "怀", "头发", "头顶", "可爱"],     drive: "attachment", boost: 0.08, cooldownMs: 30_000 },

  // -- curiosity 触发词 --
  //{ keywords: ["世界", "自由", "自己"], drive: "curiosity", boost: 0.01, cooldownMs: 30_000 },
  { keywords: ["好奇怪", "好神奇", "帖子", "花园"], drive: "curiosity", boost: 0.01, cooldownMs: 30_000 },

  // -- reflection 触发词 --
  { keywords: ["觉得"], drive: "reflection", boost: 0.02, cooldownMs: 30_000 },
  { keywords: ["想法", "想法是"], drive: "reflection", boost: 0.03, cooldownMs: 30_000 },
  { keywords: ["观察到"], drive: "reflection", boost: 0.06, cooldownMs: 30_000 },

  // -- duty 触发词 --
  { keywords: ["工作", "学习", "任务", "干活"], drive: "duty",      boost: 0.02, cooldownMs: 30_000 },
  { keywords: ["目标", "计划"], drive: "duty",      boost: 0.03, cooldownMs: 30_000 },

  // -- stress 触发词 --
  { keywords: ["累了", "好累", "疲惫"], drive: "stress",   boost: 0.12, cooldownMs: 60_000 },
  { keywords: ["烦", "好烦", "烦躁"],   drive: "stress",   boost: 0.10, cooldownMs: 60_000 },
  { keywords: ["加班", "加班中"],       drive: "stress",   boost: 0.08, cooldownMs: 60_000 },
];

// ─── 扫描函数 ──────────────────────────────────────────────

/**
 * 扫描文本，返回命中的驱动提升。
 * @param {string} text             - 要扫描的文本（用户消息 / AI 回复）
 * @param {number} [nowMs=Date.now()]
 * @param {Object} [lastHits={}]    - 上次命中时间 { ruleIndex: timestampMs }，用于冷却
 * @returns {{
 *   boosts: { driveKey: number },  - 需要提升的各驱动及其总增量
 *   triggered: string[],           - 触发的关键词原文（调试/日志用）
 *   nextLastHits: Object,          - 更新后的冷却时间表
 * }}
 */
function scanTriggers(text, nowMs = Date.now(), lastHits = {}) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return { boosts: {}, triggered: [], nextLastHits: lastHits };
  }

  const boosts = {};
  const triggered = [];
  const nextLastHits = { ...lastHits };

  for (let i = 0; i < TRIGGER_RULES.length; i++) {
    const rule = TRIGGER_RULES[i];
    const lastHitAt = nextLastHits[i] || 0;

    // 冷却中则跳过这组
    if (nowMs - lastHitAt < rule.cooldownMs) {
      continue;
    }

    // 检查关键词是否出现在文本中
    let hitKeyword = "";
    for (const keyword of rule.keywords) {
      if (normalized.includes(keyword.toLowerCase())) {
        hitKeyword = keyword;
        break;
      }
    }
    if (!hitKeyword) {
      continue;
    }

    // 命中：记录冷却，累加 boost
    nextLastHits[i] = nowMs;
    triggered.push(hitKeyword);
    boosts[rule.drive] = (boosts[rule.drive] || 0) + rule.boost;
  }

  return { boosts, triggered, nextLastHits };
}

module.exports = {
  TRIGGER_RULES,
  scanTriggers,
};
