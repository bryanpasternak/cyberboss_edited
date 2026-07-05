const RELEVANCE_SYSTEM_PROMPT = [
  "你是一个记忆相关性判断器。你的任务是判断候选的长期记忆是否与当前的对话上下文相关。",
  "",
  "\"相关\"的定义：",
  "- 记忆中提到的人物、事件、话题在当前对话中被直接提及或暗示",
  "- 记忆中的情感状态与当前对话的情感基调有联系",
  "- 记忆中的决定或未完成事项可能在当前对话中被跟进",
  "- 记忆提供了理解当前对话所需的背景信息",
  "",
  "\"不相关\"的定义：",
  "- 记忆的话题与当前对话完全不同，仅有字面关键词重叠",
  "- 过去的日常寒暄与当前具体讨论无关",
  "- 记忆内容已被当前对话的发展所覆盖/过时",
  "",
  "严格只输出 JSON。",
].join("\n");

class DeepSeekRelevanceFilter {
  constructor({ config = {}, deepseekClient = null } = {}) {
    this.config = config;
    this.client = deepseekClient;
    this.enabled = Boolean(config.chatMemoryDeepSeekRerankEnabled) && Boolean(deepseekClient);
    this.poolSize = Math.max(3, Number(config.chatMemoryDeepSeekRerankPoolSize) || 20);
    this.contextTurns = Math.max(1, Number(config.chatMemoryDeepSeekRerankContextTurns) || 5);
    this.timeoutMs = Math.max(1000, Number(config.chatMemoryDeepSeekRerankTimeoutMs) || 5000);
  }

  isEnabled() {
    return this.enabled && Boolean(this.client) && this.client.isReady();
  }

  /**
   * 对候选记忆进行相关性过滤。
   *
   * @param {Object} params
   * @param {Array} params.candidates - 向量粗排后的候选记忆列表
   * @param {Array} params.contextTurns - 最近 N 轮对话的 turn 对象（含 text 字段）
   * @param {number} [params.limit] - 最终返回的最大数量
   * @returns {Promise<Array>} 过滤后的记忆列表（保持原结构，附加 relevance_score）
   */
  async filter({ candidates = [], contextTurns = [], limit = 3 } = {}) {
    if (!candidates.length) {
      return [];
    }

    if (!this.isEnabled()) {
      return candidates.slice(0, limit);
    }

    // 只取前 poolSize 个候选送审，减少 token 消耗
    const pool = candidates.slice(0, this.poolSize);
    if (!pool.length) {
      return [];
    }

    try {
      const judgments = await this.judgeRelevance(pool, contextTurns);
      if (!judgments) {
        return candidates.slice(0, limit);
      }
      return this.applyJudgments(pool, judgments, limit);
    } catch (error) {
      console.warn(`[deepseek-rerank] filter failed, falling back to vector rank: ${error.message}`);
      return candidates.slice(0, limit);
    }
  }

  /**
   * 调用 DeepSeek 判断相关性。
   * @returns {Promise<Map|null>} memory_id → { relevant, score, reason } 的 Map，失败返回 null
   */
  async judgeRelevance(candidates, contextTurns) {
    if (!this.client || !this.client.isReady()) {
      return null;
    }

    const userContent = this.buildRelevancePrompt(candidates, contextTurns);

    // 使用独立的超时控制（比 summarizer 更短）
    const originalTimeout = this.client.timeoutMs;
    this.client.timeoutMs = this.timeoutMs;

    try {
      const result = await this.client.structuredPrompt({
        systemPrompt: RELEVANCE_SYSTEM_PROMPT,
        userContent,
        maxTokens: 2048,
        temperature: 0,
      });

      if (!result || !Array.isArray(result.judgments)) {
        return null;
      }

      const map = new Map();
      for (const judgment of result.judgments) {
        if (!judgment || typeof judgment !== "object") continue;
        const id = String(judgment.memory_id || "").trim();
        if (!id) continue;
        map.set(id, {
          relevant: judgment.relevant === true,
          score: clamp(Number(judgment.relevance_score), 0, 1),
          reason: String(judgment.reason || "").trim(),
        });
      }
      return map;
    } finally {
      this.client.timeoutMs = originalTimeout;
    }
  }

  /**
   * 构建发给 DeepSeek 的相关性判断 prompt。
   */
  buildRelevancePrompt(candidates, contextTurns) {
    const parts = [];

    // 当前对话上下文
    parts.push("【当前对话上下文 - 最近几轮】");
    if (contextTurns.length) {
      for (const turn of contextTurns) {
        const text = String(turn.text || "").trim();
        if (text) {
          // 限制每轮长度，减少 token
          parts.push(text.length > 500 ? text.slice(0, 497) + "..." : text);
        }
      }
    } else {
      parts.push("（无上下文）");
    }

    // 候选记忆
    parts.push("");
    parts.push("【候选记忆列表】");
    for (let i = 0; i < candidates.length; i++) {
      const card = candidates[i];
      const id = card.id || `candidate_${i}`;
      const category = card.category || "event";
      const title = String(card.title || card.summary || "").trim();
      const summary = String(card.summary || "").trim();
      const timeLabel = card.startAt || card.endAt || "";

      parts.push(`--- 记忆 #${i + 1} (id: ${id}) ---`);
      parts.push(`类型: ${category}`);
      parts.push(`标题: ${title}`);
      if (summary && summary !== title) {
        parts.push(`摘要: ${summary}`);
      }
      if (timeLabel) {
        parts.push(`时间: ${timeLabel}`);
      }
    }

    // 输出要求
    parts.push("");
    parts.push("请判断每条候选记忆是否与当前对话上下文相关。");
    parts.push("输出 JSON：");
    parts.push('{"judgments": [{"memory_id": "mem_xxx", "relevant": true, "relevance_score": 0.85, "reason": "一句话原因"}]}');

    return parts.join("\n");
  }

  /**
   * 将 DeepSeek 的判断结果应用到候选列表。
   * 只保留被判定为相关的记忆，按 relevance_score 排序。
   */
  applyJudgments(candidates, judgments, limit) {
    const scored = [];

    for (const card of candidates) {
      const judgment = judgments.get(card.id);
      if (judgment && judgment.relevant) {
        scored.push({
          ...card,
          relevance_score: judgment.score,
          relevance_reason: judgment.reason,
        });
      }
    }

    // 如果 DeepSeek 认为全部不相关，回退到粗排结果的前 limit 条
    // 因为可能是判断过于严格
    if (!scored.length) {
      console.warn("[deepseek-rerank] all memories judged irrelevant, falling back to vector rank");
      return candidates.slice(0, limit);
    }

    // 按相关性分数降序
    scored.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));

    return scored.slice(0, limit);
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

module.exports = { DeepSeekRelevanceFilter, RELEVANCE_SYSTEM_PROMPT };
