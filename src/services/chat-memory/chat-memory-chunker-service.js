const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { EmbeddingClient } = require("./embedding-client");
const { appendJsonLine, listFilesSorted, readJsonFile, readJsonLines, writeJsonFile } = require("./jsonl");
const { ChatMemoryMetadataService } = require("./chat-memory-metadata-service");
const { formatLocalMinute, normalizeIsoTime } = require("./time");

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_MAX_GAP_MS = 10 * 60_000;
const DEFAULT_MAX_TURNS = 6;

class ChatMemoryChunkerService {
  constructor({
    config = {},
    metadata = new ChatMemoryMetadataService({ config }),
    embeddings = new EmbeddingClient({ config }),
  } = {}) {
    this.config = config;
    this.metadata = metadata;
    this.embeddings = embeddings;
    this.enabled = Boolean(config.chatMemoryEnabled);
  }

  async processDueLogs({ reason = "manual", now = new Date(), force = false } = {}) {
    if (!this.enabled) {
      return { processedFiles: 0, chunks: 0, reason, skipped: "disabled" };
    }
    const lock = await this.acquireLock(now);
    if (!lock) {
      return { processedFiles: 0, chunks: 0, reason, skipped: "locked" };
    }
    try {
      return await this.processLogsUnlocked({ reason, now, force });
    } finally {
      await this.releaseLock(lock);
    }
  }

  async processLogsUnlocked({ reason = "manual", now = new Date(), force = false } = {}) {
    const files = listFilesSorted(this.config.chatMemoryRawDir, (name) => name.endsWith(".jsonl"));
    const state = this.loadState();
    let chunkCount = 0;
    let processedFiles = 0;
    const newState = {
      schema: "chat-memory.chunk-state.v1",
      updatedAt: now.toISOString(),
      files: { ...(state.files || {}) },
      nextChunkSeq: Number(state.nextChunkSeq) || 1,
    };

    for (const filePath of files) {
      const rawEvents = await readJsonLines(filePath);
      if (!rawEvents.length) {
        continue;
      }
      const fileKey = path.basename(filePath);
      const previous = newState.files[fileKey] || {};
      const processedEventIds = new Set(Array.isArray(previous.processedEventIds) ? previous.processedEventIds : []);
      const eligibleEvents = rawEvents.filter((event) => !processedEventIds.has(event.eventId));
      if (!eligibleEvents.length) {
        continue;
      }
      const lastEventTime = Math.max(...eligibleEvents.map((event) => Date.parse(event.createdAt) || 0));
      if (!force && reason !== "startup" && lastEventTime && now.getTime() - lastEventTime < this.getIdleMs()) {
        continue;
      }
      const turns = reduceRawEventsToTurns(rawEvents)
        .filter((turn) => turn.events.some((event) => !processedEventIds.has(event.eventId)));
      const chunks = buildChunksFromTurns(turns, {
        maxChars: this.getMaxChars(),
        maxGapMs: DEFAULT_MAX_GAP_MS,
        maxTurns: DEFAULT_MAX_TURNS,
      });
      for (const chunkDraft of chunks) {
        const chunk = await this.buildChunkRecord(chunkDraft, {
          seq: newState.nextChunkSeq,
          now,
        });
        newState.nextChunkSeq += 1;
        await appendJsonLine(this.config.chatMemoryChunksFile, chunk);
        chunkCount += 1;
      }
      for (const event of eligibleEvents) {
        if (event?.eventId) {
          processedEventIds.add(event.eventId);
        }
      }
      newState.files[fileKey] = {
        processedAt: now.toISOString(),
        processedEventIds: [...processedEventIds],
        eventCount: rawEvents.length,
      };
      processedFiles += 1;
    }

    writeJsonFile(this.config.chatMemoryStateFile, newState);
    return { processedFiles, chunks: chunkCount, reason };
  }

  async buildChunkRecord(chunkDraft, { seq, now }) {
    const metadata = await this.metadata.extractMetadata(chunkDraft);
    const embedding = await this.embeddings.embedText(`${metadata.summary}\n${chunkDraft.text}`);
    return {
      schema: "chat-memory.chunk.v1",
      id: `chk_${String(seq).padStart(6, "0")}_${crypto.createHash("sha1").update(chunkDraft.text).digest("hex").slice(0, 8)}`,
      source: "chatlog",
      createdAt: now.toISOString(),
      ...chunkDraft,
      ...metadata,
      embeddingProvider: this.embeddings.provider,
      embeddingModel: this.embeddings.model,
      embedding,
    };
  }

  loadState() {
    return readJsonFile(this.config.chatMemoryStateFile, {
      schema: "chat-memory.chunk-state.v1",
      files: {},
      nextChunkSeq: 1,
    });
  }

  getIdleMs() {
    return Math.max(0, Number(this.config.chatMemoryIdleMs) || 30 * 60_000);
  }

  getMaxChars() {
    return Math.max(300, Number(this.config.chatMemoryChunkMaxChars) || DEFAULT_MAX_CHARS);
  }

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
    };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
    try {
      const existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const createdAt = Date.parse(existing?.createdAt || "");
      if (Number.isFinite(createdAt) && now.getTime() - createdAt < 10 * 60_000) {
        return null;
      }
    } catch {}
    try {
      await fs.promises.unlink(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return null;
      }
    }
    try {
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), { encoding: "utf8", flag: "wx" });
      return lock;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return null;
      }
      throw error;
    }
  }

  async releaseLock(lock) {
    if (!lock?.path) {
      return;
    }
    try {
      const current = JSON.parse(fs.readFileSync(lock.path, "utf8"));
      if (current?.token === lock.token) {
        await fs.promises.unlink(lock.path);
      }
    } catch {}
  }
}

function reduceRawEventsToTurns(events) {
  const sorted = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event === "object")
    .slice()
    .sort(compareEvents);
  const userByEventId = new Map();
  const userEventIdsByTurnKey = new Map();
  const assistantByRunKey = new Map();
  for (const event of sorted) {
    if (event.eventType === "user.received" && event.memoryEligible !== false) {
      userByEventId.set(event.eventId, event);
    }
    if (event.eventType === "turn.linked" && event.sourceEventId) {
      const key = buildRunKey(event.threadId, event.turnId);
      if (!userEventIdsByTurnKey.has(key)) {
        userEventIdsByTurnKey.set(key, []);
      }
      userEventIdsByTurnKey.get(key).push(event.sourceEventId);
    }
    if ((event.eventType === "assistant.completed" || event.eventType === "assistant.failed") && event.threadId) {
      assistantByRunKey.set(buildRunKey(event.threadId, event.turnId), event);
      if (event.turnId) {
        assistantByRunKey.set(buildRunKey(event.threadId, ""), event);
      }
    }
  }

  const turns = [];
  const linkedUserEventIds = new Set();
  for (const [key, sourceIds] of userEventIdsByTurnKey.entries()) {
    const userEvents = sourceIds.map((id) => userByEventId.get(id)).filter(Boolean);
    if (!userEvents.length) {
      continue;
    }
    userEvents.forEach((event) => linkedUserEventIds.add(event.eventId));
    const assistant = assistantByRunKey.get(key) || null;
    const threadId = key.split(":")[0] || assistant?.threadId || "";
    const turnId = key.slice(threadId.length + 1) || assistant?.turnId || "";
    turns.push(buildTurn({ userEvents, assistant, threadId, turnId }));
  }
  for (const event of userByEventId.values()) {
    if (!linkedUserEventIds.has(event.eventId)) {
      turns.push(buildTurn({ userEvents: [event], assistant: null, threadId: "", turnId: "" }));
    }
  }
  return turns.sort((left, right) => left.startMs - right.startMs);
}

function buildTurn({ userEvents, assistant, threadId, turnId }) {
  const orderedUsers = userEvents.slice().sort(compareEvents);
  const startAt = orderedUsers[0]?.createdAt || assistant?.createdAt || new Date().toISOString();
  const endAt = assistant?.createdAt || orderedUsers[orderedUsers.length - 1]?.createdAt || startAt;
  const textParts = [];
  for (const event of orderedUsers) {
    const text = normalizeText(event.text);
    if (text) {
      textParts.push(`[苏苏] ${text}`);
    }
  }
  if (assistant && normalizeText(assistant.text) && assistant.memoryEligible !== false) {
    textParts.push(`[阿星] ${normalizeText(assistant.text)}`);
  }
  return {
    startAt,
    endAt,
    startMs: Date.parse(startAt) || 0,
    endMs: Date.parse(endAt) || Date.parse(startAt) || 0,
    channelId: normalizeText(orderedUsers[0]?.channelId),
    workspaceId: normalizeText(orderedUsers[0]?.workspaceId),
    accountId: normalizeText(orderedUsers[0]?.accountId),
    senderId: normalizeText(orderedUsers[0]?.senderId),
    bindingKey: normalizeText(orderedUsers[0]?.bindingKey),
    workspaceRoot: normalizeText(orderedUsers[0]?.workspaceRoot),
    threadId: normalizeText(threadId || assistant?.threadId),
    turnId: normalizeText(turnId || assistant?.turnId),
    turnIds: [normalizeText(turnId || assistant?.turnId)].filter(Boolean),
    text: textParts.join("\n"),
    events: [...orderedUsers, assistant].filter(Boolean),
  };
}

function buildChunksFromTurns(turns, { maxChars, maxGapMs, maxTurns }) {
  const chunks = [];
  let current = null;
  for (const turn of turns.filter((item) => normalizeText(item.text))) {
    if (!current) {
      current = createChunkDraft(turn);
      continue;
    }
    const gapMs = turn.startMs - current.endMs;
    const nextLength = current.text.length + 1 + turn.text.length;
    if (gapMs > maxGapMs || nextLength > maxChars || current.turnCount >= maxTurns) {
      chunks.push(finalizeChunkDraft(current));
      current = createChunkDraft(turn);
      continue;
    }
    mergeTurnIntoChunk(current, turn);
  }
  if (current) {
    chunks.push(finalizeChunkDraft(current));
  }
  return chunks;
}

function createChunkDraft(turn) {
  return {
    startAt: normalizeIsoTime(turn.startAt, turn.startAt),
    endAt: normalizeIsoTime(turn.endAt, turn.endAt),
    endMs: turn.endMs,
    channelId: turn.channelId,
    workspaceId: turn.workspaceId,
    accountId: turn.accountId,
    senderId: turn.senderId,
    bindingKey: turn.bindingKey,
    workspaceRoot: turn.workspaceRoot,
    threadId: turn.threadId,
    turnIds: [...turn.turnIds],
    speakerMix: inferSpeakerMix(turn.text),
    text: prependTimeLabel(turn),
    turnCount: 1,
  };
}

function mergeTurnIntoChunk(chunk, turn) {
  chunk.endAt = normalizeIsoTime(turn.endAt, turn.endAt);
  chunk.endMs = turn.endMs;
  if (!chunk.threadId && turn.threadId) chunk.threadId = turn.threadId;
  chunk.turnIds.push(...turn.turnIds.filter((id) => !chunk.turnIds.includes(id)));
  chunk.speakerMix = Array.from(new Set([...chunk.speakerMix, ...inferSpeakerMix(turn.text)]));
  chunk.text = `${chunk.text}\n${prependTimeLabel(turn)}`.trim();
  chunk.turnCount += 1;
}

function finalizeChunkDraft(chunk) {
  const { endMs, turnCount, ...record } = chunk;
  return record;
}

function prependTimeLabel(turn) {
  const label = formatLocalMinute(turn.startAt);
  return label ? `[${label}]\n${turn.text}` : turn.text;
}

function inferSpeakerMix(text) {
  const speakers = [];
  if (text.includes("[苏苏]")) speakers.push("user");
  if (text.includes("[阿星]")) speakers.push("assistant");
  return speakers;
}

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function compareEvents(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.eventId || "").localeCompare(String(right?.eventId || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ChatMemoryChunkerService,
  buildChunksFromTurns,
  reduceRawEventsToTurns,
};
