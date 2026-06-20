const { extractTimeTags, formatLocalMinute } = require("./time");

class ChatMemoryMetadataService {
  constructor({ config = {} } = {}) {
    this.config = config;
  }

  async extractMetadata({ text = "", startAt = "", endAt = "" } = {}) {
    const normalized = normalizeText(text);
    const memoryTypes = inferMemoryTypes(normalized);
    const topicTags = inferTopicTags(normalized);
    const timeTags = Array.from(new Set([
      ...extractTimeTags(normalized, endAt || startAt || new Date()),
    ]));
    const salience = inferSalience(normalized, memoryTypes);
    const emotion = inferEmotion(normalized);
    return {
      summary: buildSummary(normalized, { startAt, endAt }),
      memoryTypes,
      topicTags,
      timeTags,
      salience,
      emotion,
    };
  }
}

function inferMemoryTypes(text) {
  const types = new Set();
  if (/喜欢|偏好|讨厌|不要|别再|以后.*(要|不要)|习惯|边界/.test(text)) {
    types.add("preference");
  }
  if (/记住|别忘|以后|约定|答应|承诺|今晚|明早|明天|下次|回头|改天/.test(text)) {
    types.add("promise_candidate");
  }
  if (/项目|代码|bug|测试|实现|命令|文件|接口|API|runtime|微信|telegram|Codex|Claude/i.test(text)) {
    types.add("technical");
    types.add("project");
  }
  if (/难过|生气|开心|想你|喜欢你|陪我|抱抱|亲|委屈|焦虑|累/.test(text)) {
    types.add("emotion");
    types.add("relationship");
  }
  if (/发生|去了|今天|昨天|刚才|后来|一起|开始|完成/.test(text)) {
    types.add("event");
  }
  if (!types.size) {
    types.add("event");
  }
  return [...types];
}

function inferTopicTags(text) {
  const tags = new Set();
  if (/微信|telegram|聊天|消息/.test(text)) tags.add("chat");
  if (/项目|代码|bug|测试|实现|命令|文件|接口|runtime|Codex|Claude/i.test(text)) tags.add("technical");
  if (/记住|记忆|忘|回忆|想起/.test(text)) tags.add("memory");
  if (/今晚|明早|明天|下次|周末|回头|改天/.test(text)) tags.add("plan");
  if (/陪|喜欢|抱|亲|关系|恋人|想你/.test(text)) tags.add("relationship");
  if (!tags.size) tags.add("conversation");
  return [...tags].slice(0, 6);
}

function inferSalience(text, memoryTypes) {
  let score = 0.35;
  if (memoryTypes.includes("promise_candidate")) score += 0.25;
  if (memoryTypes.includes("preference")) score += 0.2;
  if (memoryTypes.includes("emotion")) score += 0.12;
  if (memoryTypes.includes("technical")) score += 0.08;
  if (/必须|一定|重要|不要忘|别忘|边界|不能/.test(text)) score += 0.15;
  if (text.length > 400) score += 0.05;
  return clamp(score, 0.1, 1);
}

function inferEmotion(text) {
  let valence = 0;
  let arousal = 0.3;
  if (/开心|喜欢|爱|舒服|期待|温柔|甜|安心/.test(text)) {
    valence += 0.35;
  }
  if (/难过|生气|委屈|讨厌|焦虑|怕|累|崩/.test(text)) {
    valence -= 0.35;
    arousal += 0.25;
  }
  if (/必须|马上|急|一定|现在|别忘/.test(text)) {
    arousal += 0.25;
  }
  return {
    target: "conversation",
    valence: clamp(valence, -1, 1),
    arousal: clamp(arousal, 0, 1),
  };
}

function buildSummary(text, { startAt = "", endAt = "" } = {}) {
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/\[(苏苏|阿星)\]\s*/g, "$1：")
    .trim();
  const suffix = startAt || endAt ? `（${formatLocalMinute(startAt || endAt)}）` : "";
  if (compact.length <= 160) {
    return `${compact}${suffix}`.trim();
  }
  return `${compact.slice(0, 157)}...${suffix}`.trim();
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }
  return Math.max(min, Math.min(max, numeric));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChatMemoryMetadataService };
