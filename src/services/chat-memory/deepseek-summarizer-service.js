const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { appendJsonLine, listFilesSorted, readJsonFile, readJsonLines, writeJsonFile } = require("./jsonl");
const { EmbeddingClient } = require("./embedding-client");
const { reduceRawEventsToTurns } = require("./chat-memory-chunker-service");
const { formatLocalMinute } = require("./time");

const SUMMARIZE_SYSTEM_PROMPT = [
  "你是一个亲密关系的对话记忆提取器。你阅读苏苏和阿星之间的对话记录，从中提取有意义、值得未来回忆的记忆点。",
  "",
  "你的输出必须是严格的 JSON 格式。",
  "",
  "重要原则：",
  "- 只提取值得长期记住的内容。纯寒暄、无信息量的对话返回空数组。",
  "- 对 emotion 类型的记忆，summary 中必须保留具体的情绪词（如开心、感动、心疼、委屈、想、爱、温暖、低落、焦虑、安心、依赖、骄傲、愧疚、满足），让文字本身带有情感温度。不要用\"表达了情感\"这类空洞说法——要说\"她开心地笑了，语气里带着被接住的安心\"或\"他说的每句话都让她放松下来，那种被理解的感觉让她眼眶有点热\"。",
  "- 对 preference 类型的记忆要特别重视——苏苏的偏好、习惯、边界是最高优先级的记忆，必须精确捕捉。",
  "- 不需要提取时间承诺/约定（如\"今晚做X\"\"明天记得Y\"），这由另一个系统专门处理。",
  "- 每段对话通常提取 1-5 条记忆点。如果实在没有值得记住的内容，返回空数组。",
].join("\n");

const MEMORY_CATEGORIES = ["preference", "emotion", "event", "fact", "relationship"];

class DeepSeekSummarizer {
  constructor({
    config = {},
    deepseekClient = null,
    embeddings = null,
  } = {}) {
    this.config = config;
    this.client = deepseekClient;
    this.embeddings = embeddings || new EmbeddingClient({ config });
    this.enabled = Boolean(config.chatMemoryDeepSeekEnabled) && Boolean(deepseekClient);
  }

  /**
   * 处理尚未总结的 raw events。
   * @param {Object} options
   * @param {string} options.reason - 触发原因: "cron" | "startup" | "manual"
   * @param {Date} [options.now] - 当前时间
   * @param {boolean} [options.force] - 是否跳过时间检查
   * @returns {Promise<Object>} 处理结果摘要
   */
  async processDueLogs({ reason = "manual", now = new Date(), force = false } = {}) {
    if (!this.enabled || !this.client) {
      return { processedFiles: 0, memoryCards: 0, reason, skipped: "disabled" };
    }

    const lock = await this.acquireLock(now);
    if (!lock) {
      return { processedFiles: 0, memoryCards: 0, reason, skipped: "locked" };
    }

    try {
      return await this.processLogsUnlocked({ reason, now, force });
    } finally {
      await this.releaseLock(lock);
    }
  }

  async processLogsUnlocked({ reason = "manual", now = new Date(), force = false }) {
    const files = listFilesSorted(this.config.chatMemoryRawDir, (name) => name.endsWith(".jsonl"));
    const state = this.loadState();
    let totalCards = 0;
    let processedFiles = 0;

    const newState = {
      schema: "chat-memory.summary-state.v1",
      updatedAt: now.toISOString(),
      files: { ...(state.files || {}) },
      nextMemorySeq: Number(state.nextMemorySeq) || 1,
    };

    for (const filePath of files) {
      const rawEvents = await readJsonLines(filePath);
      if (!rawEvents.length) {
        continue;
      }

      const fileKey = path.basename(filePath);
      const previous = newState.files[fileKey] || {};
      const processedEventIds = new Set(
        Array.isArray(previous.processedEventIds) ? previous.processedEventIds : []
      );
      const eligibleEvents = rawEvents.filter((event) => !processedEventIds.has(event.eventId));
      if (!eligibleEvents.length) {
        continue;
      }

      // 如果不 force 且不是 startup，检查最后一条事件时间是否足够近
      if (!force && reason !== "startup") {
        const lastEventTime = Math.max(
          ...eligibleEvents.map((event) => Date.parse(event.createdAt) || 0)
        );
        // cron 触发时不跳过——到时间就该总结
      }

      const allTurns = reduceRawEventsToTurns(rawEvents);
      const turns = allTurns.filter((turn) =>
        turn.events.some((event) => !processedEventIds.has(event.eventId))
      );
      if (!turns.length) {
        continue;
      }

      const batches = this.batchTurns(turns);
      const fileCards = [];
      const successEventIds = [];

      for (const batch of batches) {
        const cards = await this.summarizeBatch(batch, now);
        if (cards === null) {
          // DeepSeek 调用失败，跳过这批，eventId 不标记为已处理
          console.warn(
            `[deepseek-summarizer] batch failed for ${fileKey}, will retry next cron`
          );
          continue;
        }

        // 收集本批涉及的 eventIds
        for (const turn of batch) {
          for (const event of turn.events) {
            if (event?.eventId && !processedEventIds.has(event.eventId)) {
              successEventIds.push(event.eventId);
            }
          }
        }

        // 为每张卡片嵌入向量并写入
        for (const card of cards) {
          const record = await this.buildMemoryCard(card, batch, {
            seq: newState.nextMemorySeq,
            now,
          });
          newState.nextMemorySeq += 1;
          await appendJsonLine(this.config.chatMemoryMemoriesFile, record);
          fileCards.push(record);
          totalCards += 1;
        }
      }

      // 标记已处理的 events
      for (const eventId of successEventIds) {
        processedEventIds.add(eventId);
      }

      newState.files[fileKey] = {
        processedAt: now.toISOString(),
        processedEventIds: [...processedEventIds],
        eventCount: rawEvents.length,
        producedMemoryCards: fileCards.length,
      };
      processedFiles += 1;
    }

    newState.lastSummaryAt = now.toISOString();
    writeJsonFile(this.config.chatMemorySummaryStateFile, newState);

    return { processedFiles, memoryCards: totalCards, reason };
  }

  /**
   * 将 turns 按字符数分批，每批控制在 maxCharsPerBatch 以内。
   */
  batchTurns(turns) {
    const maxChars = Math.max(500, Number(this.config.chatMemorySummaryMaxCharsPerBatch) || 6000);
    const batches = [];
    let current = [];
    let currentChars = 0;

    for (const turn of turns) {
      const turnChars = (turn.text || "").length;
      if (currentChars + turnChars > maxChars && current.length > 0) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(turn);
      currentChars += turnChars;
    }
    if (current.length) {
      batches.push(current);
    }
    return batches;
  }

  /**
   * 发送一批 turns 给 DeepSeek 做总结。
   * @returns {Promise<Array|null>} 记忆卡片数组，失败返回 null
   */
  async summarizeBatch(turns, now = new Date()) {
    if (!this.client || !this.client.isReady()) {
      return null;
    }

    const turnsText = turns
      .map((turn) => {
        const timeLabel = formatLocalMinute(turn.startAt);
        return timeLabel ? `[${timeLabel}]\n${turn.text}` : turn.text;
      })
      .join("\n\n");

    if (!turnsText.trim()) {
      return [];
    }

    const userContent = [
      "请阅读以下对话记录，提取其中值得长期记住的内容。",
      "",
      `记忆类型：${MEMORY_CATEGORIES.join("、")}`,
      "",
      "每个记忆点必须包含：",
      "- category: 上述类型之一",
      "- title: 简短标题（15字以内）",
      "- summary: 2-4句话的总结。emotion 类型必须包含具体情绪词汇。",
      "- salience: 0到1的重要性评分（0.5=普通, 0.7=比较重要, 0.9+=非常重要）",
      "- emotion_valence: -1到1的情感效价",
      "- emotion_arousal: 0到1的情感唤醒度",
      "",
      "对话记录：",
      "---",
      turnsText,
      "---",
      "",
      `请以以下 JSON 格式返回（当前时间 ${formatLocalMinute(now)}）：`,
      `{"memories": [{"category": "...", "title": "...", "summary": "...", "salience": 0.7, "emotion_valence": 0.5, "emotion_arousal": 0.3}]}`,
    ].join("\n");

    const result = await this.client.structuredPrompt({
      systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
      userContent,
      maxTokens: 4096,
      temperature: 0.3,
    });

    if (!result || !Array.isArray(result.memories)) {
      return null;
    }

    // 验证并清理每张卡片
    return result.memories
      .filter((card) => card && typeof card === "object")
      .map((card) => this.normalizeCard(card))
      .filter(Boolean);
  }

  /**
   * 标准化并验证一张记忆卡片。
   */
  normalizeCard(card) {
    const category = String(card.category || "").trim().toLowerCase();
    if (!MEMORY_CATEGORIES.includes(category)) {
      return null;
    }

    const title = String(card.title || "").trim();
    const summary = String(card.summary || "").trim();
    if (!title || !summary) {
      return null;
    }

    return {
      category,
      title: title.slice(0, 60),
      summary: summary.slice(0, 600),
      salience: clamp(Number(card.salience), 0.1, 1),
      emotion_valence: clamp(Number(card.emotion_valence), -1, 1),
      emotion_arousal: clamp(Number(card.emotion_arousal), 0, 1),
    };
  }

  /**
   * 构建完整的记忆卡片记录，包含嵌入向量。
   */
  async buildMemoryCard(card, sourceTurns, { seq, now }) {
    const firstTurn = sourceTurns[0] || {};
    const lastTurn = sourceTurns[sourceTurns.length - 1] || {};

    // 收集所有涉及的 eventIds 和 speaker 信息
    const eventIds = [];
    const speakers = new Set();
    const threadIds = new Set();
    for (const turn of sourceTurns) {
      for (const event of turn.events || []) {
        if (event?.eventId) eventIds.push(event.eventId);
      }
      if (turn.threadId) threadIds.add(turn.threadId);
      if (turn.senderId) speakers.add("user");
      if (turn.text && turn.text.includes("[阿星]")) speakers.add("assistant");
    }

    // 构建对话原文（用于全文本检索 fallback）
    const sourceText = sourceTurns
      .map((turn) => {
        const timeLabel = formatLocalMinute(turn.startAt);
        return timeLabel ? `[${timeLabel}]\n${turn.text}` : turn.text;
      })
      .join("\n");

    // 嵌入：title + summary
    const embedText = `${card.title}\n${card.summary}`;
    const embedding = await this.embeddings.embedText(embedText);

    return {
      schema: "chat-memory.memory-card.v1",
      id: `mem_${String(seq).padStart(6, "0")}_${crypto.createHash("sha1").update(embedText).digest("hex").slice(0, 8)}`,
      source: "deepseek-summary",
      createdAt: now.toISOString(),
      sourceEventIds: eventIds,
      sourceThreadIds: [...threadIds],
      startAt: firstTurn.startAt || now.toISOString(),
      endAt: lastTurn.endAt || now.toISOString(),
      category: card.category,
      title: card.title,
      summary: card.summary,
      text: sourceText,
      speakerMix: [...speakers],
      salience: card.salience,
      emotion: {
        valence: card.emotion_valence,
        arousal: card.emotion_arousal,
      },
      embeddingProvider: this.embeddings.provider,
      embeddingModel: this.embeddings.model,
      embedding,
    };
  }

  // ─── state 管理 ──────────────────────────────────────────

  loadState() {
    return readJsonFile(this.config.chatMemorySummaryStateFile, {
      schema: "chat-memory.summary-state.v1",
      files: {},
      nextMemorySeq: 1,
    });
  }

  // ─── 锁机制（复用 chunker 的模式） ──────────────────────

  async acquireLock(now = new Date()) {
    const lockPath = this.config.chatMemoryProcessingLockFile;
    if (!lockPath) {
      return { path: "" };
    }
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const lock = {
      path: lockPath,
      token: crypto.randomBytes(8).toString("hex"),
      createdAt: now.toISOString(),
      owner: "deepseek-summarizer",
    };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    // 检查过期锁（10 分钟超时）
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const createdAt = Date.parse(existing?.createdAt || "");
      if (Number.isFinite(createdAt) && now.getTime() - createdAt < 10 * 60_000) {
        return null;
      }
    } catch {}
    // 删除过期锁并重试
    try {
      await fs.promises.unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      throw error;
    }
  }

  async releaseLock(lock) {
    if (!lock?.path) return;
    try {
      const current = JSON.parse(fs.readFileSync(lock.path, "utf8"));
      if (current?.token === lock.token) {
        await fs.promises.unlink(lock.path);
      }
    } catch {}
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

module.exports = { DeepSeekSummarizer, SUMMARIZE_SYSTEM_PROMPT, MEMORY_CATEGORIES };
