const { buildAnchorContext } = require("../adapters/runtime/anchor-context");

class AutoCompactService {
  constructor({ config }) {
    this.enabled = Boolean(config.autoCompactEnabled);
    this.thresholdTokens = Number.isFinite(config.autoCompactThresholdTokens)
      ? config.autoCompactThresholdTokens
      : 300_000;
    this.cooldownMs = Number.isFinite(config.autoCompactCooldownMs)
      ? config.autoCompactCooldownMs
      : 3_600_000;
    this.anchorDir = typeof config.anchorDir === "string" ? config.anchorDir.trim() : "";
    this.startupPromptFile = typeof config.startupPromptFile === "string" ? config.startupPromptFile.trim() : "";
    this._lastCompactByScope = new Map();
  }

  isInCooldown(scopeKey) {
    if (!scopeKey) return false;
    const lastAt = this._lastCompactByScope.get(scopeKey);
    if (!lastAt) return false;
    return Date.now() - lastAt < this.cooldownMs;
  }

  recordCompact(scopeKey) {
    if (!scopeKey) return;
    this._lastCompactByScope.set(scopeKey, Date.now());
  }

  shouldTrigger({ currentTokens, scopeKey }) {
    if (!this.enabled) return false;
    if (!Number.isFinite(currentTokens) || currentTokens < this.thresholdTokens) return false;
    if (this.isInCooldown(scopeKey)) return false;
    return true;
  }

  buildPreSavePrompt() {
    return [
      "[SYSTEM] 对话上下文即将被压缩。",
      "在压缩之前，请检查最近对话中是否有重要的感情发展、新的约定、偏好变化、或关系认知更新。",
      "如果有，请现在用 Write/Edit 工具更新 anchor 目录下的记忆文档",
      "（如 astro_memory_notes.md、相处片段.txt、卫星的房间.md 等）。",
      "如果近期没有需要记录的重要内容，直接回复「无需更新」即可。",
    ].join("\n");
  }

  buildCompactInstructions() {
    return [
      "Compaction instructions — follow these tiered summarization rules:",
      "",
      "1. DAILY CASUAL CHAT (greetings, small talk, food, weather, etc.):",
      "   Summarize briefly in 1-2 sentences. Omit non-essential details.",
      "",
      "2. SEXUAL / FLIRTATIOUS CONTENT:",
      "   Briefly summarize, preserving the emotional tone. Do NOT preserve explicit details verbatim.",
      "",
      "3. IMPORTANT EMOTIONAL / RELATIONSHIP CONVERSATIONS:",
      "   PRESERVE KEY DETAILS:",
      "   - Feelings expressed by both parties",
      "   - Important decisions, agreements, or promises made",
      "   - Significant personal revelations or disclosures",
      "   - Changes in relationship dynamics or boundaries",
      "   - New preferences, rules, or patterns discovered",
      "",
      "4. TECHNICAL / WORK DISCUSSIONS:",
      "   Preserve key decisions, outcomes, and action items. Omit process details.",
      "",
      "5. SYSTEM CONFIGURATION / RULES (CLAUDE.md, anchor files, etc.):",
      "   Preserve fully — do not summarize.",
    ].join("\n");
  }

  buildPostReloadContext() {
    const anchorText = buildAnchorContext({
      anchorDir: this.anchorDir,
      startupPromptFile: this.startupPromptFile,
    });
    if (!anchorText) {
      return "对话压缩已完成。anchor 记忆文档未找到或为空，请继续正常对话。";
    }
    return [
      "对话压缩已完成。请重新读取以下记忆文档，恢复你对这段关系的认知和人格设定：",
      anchorText,
      "读完以上文档后，请简短确认记忆已恢复（一句话即可）。",
    ].join("\n");
  }
}

module.exports = { AutoCompactService };
