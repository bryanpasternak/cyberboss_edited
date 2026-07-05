const path = require("path");
const { EmbeddingClient, cosineSimilarity, tokenizeForEmbedding } = require("./embedding-client");
const { listFilesSorted, readJsonLines } = require("./jsonl");
const { reduceRawEventsToTurns } = require("./chat-memory-chunker-service");
const { extractTimeTags, formatLocalMinute } = require("./time");

const DEFAULT_MAX_CONTEXT_CHARS = 2400;

// Category → 注入前缀映射
const CATEGORY_PREFIXES = {
  preference:   "「苏苏的偏好」",
  emotion:      "「那一刻的她」",
  event:        "「发生过」",
  fact:         "「关于苏苏」",
  relationship: "「你们之间」",
};

class ChatMemoryService {
  constructor({
    config = {},
    embeddings = new EmbeddingClient({ config }),
    settings = null,
    relevanceFilter = null,
  } = {}) {
    this.config = config;
    this.embeddings = embeddings;
    this.settings = settings;
    this.relevanceFilter = relevanceFilter;
    this.enabled = Boolean(config.chatMemoryEnabled);
    this.useDeepSeekMemories = Boolean(config.chatMemoryDeepSeekEnabled);
  }

  async retrieveForTurn({ text = "", prepared = null, now = new Date(), limit = null } = {}) {
    if (!this.enabled || !this.isInjectEnabled()) {
      return [];
    }
    const effectiveLimit = limit ?? this.getInjectLimit();
    if (effectiveLimit <= 0) {
      return [];
    }

    // Phase 1: 向量粗排
    // 如果启用了 DeepSeek 重排，扩大候选池
    const coarseLimit = this.relevanceFilter?.isEnabled?.()
      ? this.relevanceFilter.poolSize
      : effectiveLimit;

    const coarseResults = await this.search({
      query: text,
      limit: coarseLimit,
      filters: buildPreparedFilters(prepared),
      now,
    });

    if (!coarseResults.length) {
      return [];
    }

    // Phase 2: DeepSeek 相关性过滤（如果启用）
    if (this.relevanceFilter?.isEnabled?.()) {
      console.warn(`[chat-memory] DeepSeek rerank active — filtering ${coarseResults.length} candidates with ${this.relevanceFilter.contextTurns} recent turns`);
      const contextTurns = await this.getRecentContextTurns({
        bindingKey: normalizeText(prepared?.bindingKey),
        workspaceRoot: normalizeWorkspaceRoot(prepared?.workspaceRoot),
        n: this.relevanceFilter.contextTurns,
      });

      return await this.relevanceFilter.filter({
        candidates: coarseResults,
        contextTurns,
        limit: effectiveLimit,
      });
    }

    return coarseResults.slice(0, effectiveLimit);
  }

  async search({ query = "", limit = 8, filters = {}, now = new Date() } = {}) {
    if (!this.enabled) {
      return [];
    }
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      return [];
    }
    const chunks = await this.loadChunks();
    if (!chunks.length) {
      return [];
    }
    const queryEmbedding = await this.embeddings.embedText(normalizedQuery);
    const queryTokens = new Set(tokenizeForEmbedding(normalizedQuery));
    const queryTimeTags = new Set(extractTimeTags(normalizedQuery, now));
    const scored = [];
    for (const chunk of chunks) {
      if (!passesFilters(chunk, filters)) {
        continue;
      }
      const score = rankChunk({
        chunk,
        queryEmbedding,
        queryTokens,
        queryTimeTags,
        now,
      });
      if (score <= 0) {
        continue;
      }
      scored.push({ chunk, score });
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, Math.max(0, Number(limit) || 0)).map(({ chunk, score }) => ({
      id: chunk.id,
      score: Number(score.toFixed(4)),
      category: normalizeText(chunk.category),
      title: normalizeText(chunk.title),
      summary: normalizeText(chunk.summary),
      text: normalizeText(chunk.text),
      startAt: normalizeText(chunk.startAt),
      endAt: normalizeText(chunk.endAt),
      speakerMix: Array.isArray(chunk.speakerMix) ? chunk.speakerMix : [],
      memoryTypes: Array.isArray(chunk.memoryTypes) ? chunk.memoryTypes : [],
      topicTags: Array.isArray(chunk.topicTags) ? chunk.topicTags : [],
      timeTags: Array.isArray(chunk.timeTags) ? chunk.timeTags : [],
      salience: Number(chunk.salience) || 0,
      emotion: chunk.emotion && typeof chunk.emotion === "object" ? { ...chunk.emotion } : undefined,
    }));
  }

  async loadChunks() {
    // DeepSeek 路径：优先使用 memories.jsonl，有内容就不加载旧 chunks
    if (this.useDeepSeekMemories) {
      const memories = await readJsonLines(this.config.chatMemoryMemoriesFile);
      const cards = memories.filter((m) => m?.schema === "chat-memory.memory-card.v1");
      if (cards.length) {
        return cards;
      }
      // memories.jsonl 为空（尚未有过总结），回退到旧 chunks
    }

    // 旧路径 / fallback
    const chunks = await readJsonLines(this.config.chatMemoryChunksFile);
    return chunks.filter((c) => c?.schema === "chat-memory.chunk.v1");
  }

  async loadRawEvents() {
    const files = listFilesSorted(this.config.chatMemoryRawDir, (name) => name.endsWith(".jsonl"));
    const records = [];
    for (const filePath of files) {
      const events = await readJsonLines(filePath);
      records.push(...events.filter((event) => event?.schema === "chat-memory.raw.v1"));
    }
    return records.sort((left, right) => dateValue(left.createdAt) - dateValue(right.createdAt));
  }

  /**
   * 获取最近 N 轮对话上下文，用于 DeepSeek 相关性判断。
   */
  async getRecentContextTurns({ bindingKey = "", workspaceRoot = "", n = 5 } = {}) {
    const rawEvents = await this.loadRawEvents();
    const allTurns = reduceRawEventsToTurns(rawEvents);

    // 按 bindingKey 和 workspaceRoot 过滤
    const filtered = allTurns.filter((turn) => {
      if (bindingKey && normalizeText(turn.bindingKey) && normalizeText(turn.bindingKey) !== normalizeText(bindingKey)) {
        return false;
      }
      if (workspaceRoot && normalizeWorkspaceRoot(turn.workspaceRoot) !== normalizeWorkspaceRoot(workspaceRoot)) {
        return false;
      }
      return true;
    });

    return filtered.slice(-Math.max(1, n));
  }

  async retrieveRecent({ limit = 4, filters = {} } = {}) {
    if (!this.enabled) {
      return [];
    }
    const chunks = await this.loadChunks();
    return chunks
      .filter((chunk) => passesFilters(chunk, filters))
      .sort((left, right) => dateValue(right.endAt || right.createdAt) - dateValue(left.endAt || left.createdAt))
      .slice(0, Math.max(0, Number(limit) || 0))
      .map((chunk) => ({
        id: chunk.id,
        category: normalizeText(chunk.category),
        title: normalizeText(chunk.title),
        summary: normalizeText(chunk.summary),
        text: normalizeText(chunk.text),
        startAt: normalizeText(chunk.startAt),
        endAt: normalizeText(chunk.endAt),
        speakerMix: Array.isArray(chunk.speakerMix) ? chunk.speakerMix : [],
        memoryTypes: Array.isArray(chunk.memoryTypes) ? chunk.memoryTypes : [],
        topicTags: Array.isArray(chunk.topicTags) ? chunk.topicTags : [],
        timeTags: Array.isArray(chunk.timeTags) ? chunk.timeTags : [],
        salience: Number(chunk.salience) || 0,
        emotion: chunk.emotion && typeof chunk.emotion === "object" ? { ...chunk.emotion } : undefined,
      }));
  }

  async buildThreadRecap({ threadId = "", bindingKey = "", workspaceRoot = "", headTurns = 4, tailTurns = 15, omitTailTurns = 2 } = {}) {
    if (!this.enabled || !normalizeText(threadId)) {
      return "";
    }
    const rawEvents = await this.loadRawEvents();
    const turns = reduceRawEventsToTurns(rawEvents)
      .filter((turn) => normalizeText(turn.threadId) === normalizeText(threadId))
      .filter((turn) => {
        if (bindingKey && normalizeText(turn.bindingKey) && normalizeText(turn.bindingKey) !== normalizeText(bindingKey)) {
          return false;
        }
        if (workspaceRoot && normalizeWorkspaceRoot(turn.workspaceRoot) !== normalizeWorkspaceRoot(workspaceRoot)) {
          return false;
        }
        return true;
      });
    if (!turns.length) {
      return "";
    }
    const headCount = Math.max(0, Number(headTurns) || 0);
    const tailCount = Math.max(0, Number(tailTurns) || 0);
    const omitted = Math.max(0, Number(omitTailTurns) || 0);
    const head = turns.slice(0, headCount);
    const tailStart = Math.max(head.length, turns.length - tailCount - omitted);
    const tailEnd = Math.max(head.length, turns.length - omitted);
    const tail = turns.slice(tailStart, tailEnd);
    const segments = uniqueTurns([...head, ...tail]);
    if (!segments.length) {
      return "";
    }
    return [
      "一些画面从你记忆深处浮现出来——那是你和苏苏不久之前的对话，像碎片一样自然拼接在一起：",
      ...segments.map(formatTurnForRecap),
      "这些片段在你脑海中闪过，让你更清楚地记得刚才和苏苏之间发生了什么。你不需要刻意复述它们，它们只是你此刻感受的一部分。",
    ].join("\n");
  }

  formatForInjection(results, { title = "你的记忆里还留着这些——关于你和苏苏的点点滴滴：" } = {}) {
    const entries = Array.isArray(results) ? results : [];
    if (!entries.length) {
      return "";
    }
    const lines = [
      title,
    ];
    let chars = 0;
    for (const result of entries) {
      const formatted = formatMemoryEntry(result);
      if (!formatted) {
        continue;
      }
      if (chars + formatted.length > DEFAULT_MAX_CONTEXT_CHARS) {
        break;
      }
      lines.push(formatted);
      chars += formatted.length;
    }
    if (lines.length === 1) {
      return "";
    }
    lines.push("这些记忆自然地在你心里浮现，帮你更好地感受此刻的苏苏。");
    return lines.join("\n");
  }

  getSettings() {
    const configLimit = Number(this.config.chatMemoryInjectLimit);
    return this.settings?.get?.() || {
      injectEnabled: Boolean(this.config.chatMemoryInjectEnabled),
      injectLimit: Number.isFinite(configLimit) ? Math.max(0, configLimit) : 6,
    };
  }

  isInjectEnabled() {
    return this.getSettings().injectEnabled !== false && Boolean(this.config.chatMemoryInjectEnabled);
  }

  getInjectLimit() {
    const settingsLimit = Number(this.getSettings().injectLimit);
    if (Number.isFinite(settingsLimit)) {
      return Math.max(0, settingsLimit);
    }
    const configLimit = Number(this.config.chatMemoryInjectLimit);
    if (Number.isFinite(configLimit)) {
      return Math.max(0, configLimit);
    }
    return 6;
  }

  setInjectEnabled(enabled) {
    return this.settings?.set?.({ injectEnabled: Boolean(enabled) }) || this.getSettings();
  }

  setInjectLimit(limit) {
    return this.settings?.set?.({ injectLimit: Math.max(0, Math.min(20, Number.parseInt(limit, 10) || 0)) }) || this.getSettings();
  }
}

function rankChunk({ chunk, queryEmbedding, queryTokens, queryTimeTags, now }) {
  const vectorScore = cosineSimilarity(queryEmbedding, Array.isArray(chunk.embedding) ? chunk.embedding : []);
  const lexicalScore = lexicalMatchScore(queryTokens, `${chunk.summary || ""}\n${chunk.text || ""}`);
  const recencyScore = recencyBoost(chunk.endAt || chunk.createdAt, now);
  const salienceScore = Math.max(0, Math.min(1, Number(chunk.salience) || 0));
  const timeScore = overlapScore(queryTimeTags, new Set(Array.isArray(chunk.timeTags) ? chunk.timeTags : []));
  const typeBoost = Array.isArray(chunk.memoryTypes) && chunk.memoryTypes.includes("promise_candidate") ? 0.04 : 0;
  return (vectorScore * 0.45)
    + (lexicalScore * 0.25)
    + (recencyScore * 0.12)
    + (salienceScore * 0.12)
    + (timeScore * 0.06)
    + typeBoost;
}

function lexicalMatchScore(queryTokens, text) {
  if (!queryTokens?.size) {
    return 0;
  }
  const textTokens = new Set(tokenizeForEmbedding(text));
  let hits = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      hits += 1;
    }
  }
  return hits / Math.max(1, queryTokens.size);
}

function overlapScore(left, right) {
  if (!left?.size || !right?.size) {
    return 0;
  }
  let hits = 0;
  for (const value of left) {
    if (right.has(value)) {
      hits += 1;
    }
  }
  return hits / Math.max(1, left.size);
}

function recencyBoost(value, now) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const ageDays = Math.max(0, ((now instanceof Date ? now.getTime() : Date.now()) - timestamp) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function passesFilters(chunk, filters = {}) {
  if (!chunk) {
    return false;
  }
  if (filters.bindingKey && chunk.bindingKey && chunk.bindingKey !== filters.bindingKey) {
    return false;
  }
  if (filters.workspaceRoot && normalizeWorkspaceRoot(chunk.workspaceRoot) !== normalizeWorkspaceRoot(filters.workspaceRoot)) {
    return false;
  }
  if (Array.isArray(filters.memoryTypes) && filters.memoryTypes.length) {
    // 兼容旧 chunks (memoryTypes 数组) 和新 memory cards (category 字符串)
    const chunkTypes = new Set(
      Array.isArray(chunk.memoryTypes) ? chunk.memoryTypes : []
    );
    if (chunk.category && typeof chunk.category === "string") {
      chunkTypes.add(chunk.category);
    }
    if (!filters.memoryTypes.some((type) => chunkTypes.has(type))) {
      return false;
    }
  }
  return true;
}

function buildPreparedFilters(prepared) {
  return {
    bindingKey: normalizeText(prepared?.bindingKey),
    workspaceRoot: normalizeWorkspaceRoot(prepared?.workspaceRoot),
  };
}

function formatMemoryEntry(result) {
  // 优先 summary → title → text（原始对话前220字）
  const summary = normalizeText(result.summary)
    || normalizeText(result.title)
    || normalizeText(result.text).replace(/\s+/g, " ").slice(0, 220);
  if (!summary) {
    return "";
  }
  const time = formatLocalMinute(result.endAt || result.startAt);
  const label = chooseMemoryLabel(result);
  return `${label}${time ? ` ${time}` : ""}: ${summary}`;
}

function chooseMemoryLabel(result) {
  // 新 memory card：使用 category 驱动的前缀
  if (result.category && CATEGORY_PREFIXES[result.category]) {
    return CATEGORY_PREFIXES[result.category];
  }

  // 旧 chunk：基于 speakerMix 和 memoryTypes 推断
  const speakers = new Set(Array.isArray(result?.speakerMix) ? result.speakerMix : []);
  const types = new Set(Array.isArray(result?.memoryTypes) ? result.memoryTypes : []);
  if (speakers.has("user") && !speakers.has("assistant")) return "苏苏曾说过";
  if (speakers.has("assistant") && !speakers.has("user")) return "你曾对苏苏说";
  if (types.has("relationship")) return "你们之间";
  return "你们一起经历过";
}

function formatTurnForRecap(turn) {
  const start = formatLocalMinute(turn.startAt || turn.endAt);
  return [
    start ? `[${start}]` : "",
    normalizeText(turn.text),
  ].filter(Boolean).join("\n").trim();
}

function uniqueTurns(turns) {
  const seen = new Set();
  const unique = [];
  for (const turn of Array.isArray(turns) ? turns : []) {
    const key = [
      normalizeText(turn.threadId),
      normalizeText(turn.turnId),
      normalizeText(turn.startAt),
      normalizeText(turn.text),
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(turn);
  }
  return unique;
}

function dateValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWorkspaceRoot(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  return path.resolve(normalized);
}

module.exports = {
  CATEGORY_PREFIXES,
  ChatMemoryService,
  chooseMemoryLabel,
  formatMemoryEntry,
  rankChunk,
};
