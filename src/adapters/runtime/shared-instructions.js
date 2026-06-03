const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    "MESSAGE LABELING CONVENTION (重要):",
    "- 以 [苏苏 · 时间] 开头的内容是用户(苏苏)当下发来的消息。",
    "- 【长期记忆参考】块里的条目是历史摘要，不是当前消息：",
    "    [苏苏说过] = 苏苏过去说过的话或偏好；",
    "    [阿星说过] = 你自己过去说过的话；",
    "    [阿星观察] = 你过去对苏苏的观察、规则或总结；",
    "    [关系事实] = 客观关系事实(称呼、人设、共同记忆等)。",
    "  绝不要把这些历史条目当作苏苏现在正在说的话来回复。",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  if (!instructions) {
    return "Refresh your WeChat behavior for this existing thread. Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.";
  }
  return [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated WeChat instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.",
    "",
    instructions,
  ].join("\n").trim();
}

function loadWechatInstructions(config = {}) {
  const persona = loadInstructionFile(config.weixinInstructionsFile, config);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (operations) {
    sections.push(operations);
  }
  return sections.join("\n\n").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

module.exports = {
  buildOpeningTurnText,
  buildInstructionRefreshText,
  loadWechatInstructions,
  loadInstructionFile,
};
