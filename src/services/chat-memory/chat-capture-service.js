const crypto = require("crypto");
const path = require("path");

const { appendJsonLine } = require("./jsonl");
const { formatDateKey, normalizeIsoTime } = require("./time");

class ChatCaptureService {
  constructor({ config = {}, scheduler = null } = {}) {
    this.config = config;
    this.scheduler = scheduler;
    this.enabled = Boolean(config.chatMemoryEnabled && config.chatMemoryCaptureEnabled);
  }

  setScheduler(scheduler) {
    this.scheduler = scheduler;
  }

  async appendUserReceived({ prepared, bindingKey = "", workspaceRoot = "", channelId = "" } = {}) {
    if (!this.enabled || !prepared) {
      return "";
    }
    const text = normalizeText(prepared.originalText ?? prepared.text);
    const attachments = normalizeAttachments(prepared.attachments);
    if (!text && !attachments.length) {
      return "";
    }
    const record = this.buildBaseRecord({
      eventType: "user.received",
      createdAt: prepared.receivedAt,
      bindingKey,
      workspaceRoot,
    });
    Object.assign(record, {
      channelId: normalizeText(channelId) || normalizeText(prepared.channelId) || normalizeText(prepared.provider),
      provider: normalizeText(prepared.provider),
      workspaceId: normalizeText(prepared.workspaceId),
      accountId: normalizeText(prepared.accountId),
      senderId: normalizeText(prepared.senderId),
      messageId: normalizeText(prepared.messageId),
      text,
      attachments,
      memoryEligible: Boolean(text),
    });
    return await this.safeAppend(record);
  }

  async appendTurnLinked({ sourceEventId = "", threadId = "", turnId = "", bindingKey = "", workspaceRoot = "" } = {}) {
    if (!this.enabled || !sourceEventId) {
      return "";
    }
    const record = this.buildBaseRecord({
      eventType: "turn.linked",
      bindingKey,
      workspaceRoot,
    });
    Object.assign(record, {
      sourceEventId: normalizeText(sourceEventId),
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
    });
    return await this.safeAppend(record);
  }

  async appendAssistantCompleted({ threadId = "", turnId = "", text = "", linked = null } = {}) {
    return await this.appendAssistantEvent({
      eventType: "assistant.completed",
      threadId,
      turnId,
      text,
      linked,
      memoryEligible: true,
    });
  }

  async appendAssistantFailed({ threadId = "", turnId = "", text = "", linked = null } = {}) {
    return await this.appendAssistantEvent({
      eventType: "assistant.failed",
      threadId,
      turnId,
      text,
      linked,
      memoryEligible: false,
    });
  }

  async appendDispatchFailed({ sourceEventId = "", text = "", bindingKey = "", workspaceRoot = "" } = {}) {
    if (!this.enabled || !sourceEventId) {
      return "";
    }
    const record = this.buildBaseRecord({
      eventType: "assistant.failed",
      bindingKey,
      workspaceRoot,
    });
    Object.assign(record, {
      sourceEventId: normalizeText(sourceEventId),
      text: normalizeText(text) || "dispatch failed",
      memoryEligible: false,
    });
    return await this.safeAppend(record);
  }

  async appendSystemEvent({ eventType = "system.event", text = "", bindingKey = "", workspaceRoot = "", extra = {} } = {}) {
    if (!this.enabled) {
      return "";
    }
    const record = this.buildBaseRecord({ eventType, bindingKey, workspaceRoot });
    Object.assign(record, {
      text: normalizeText(text),
      memoryEligible: false,
      ...(extra && typeof extra === "object" ? extra : {}),
    });
    return await this.safeAppend(record);
  }

  async appendAssistantEvent({ eventType, threadId, turnId, text, linked, memoryEligible }) {
    if (!this.enabled) {
      return "";
    }
    const normalizedText = normalizeText(text);
    if (!normalizedText && eventType === "assistant.completed") {
      return "";
    }
    const record = this.buildBaseRecord({
      eventType,
      bindingKey: linked?.bindingKey,
      workspaceRoot: linked?.workspaceRoot,
    });
    Object.assign(record, {
      threadId: normalizeText(threadId),
      turnId: normalizeText(turnId),
      text: normalizedText,
      memoryEligible,
    });
    return await this.safeAppend(record);
  }

  buildBaseRecord({ eventType, createdAt = "", bindingKey = "", workspaceRoot = "" } = {}) {
    return {
      schema: "chat-memory.raw.v1",
      eventId: `evt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      eventType,
      createdAt: normalizeIsoTime(createdAt, new Date().toISOString()),
      bindingKey: normalizeText(bindingKey),
      workspaceRoot: normalizeText(workspaceRoot),
    };
  }

  async safeAppend(record) {
    try {
      const filePath = this.resolveRawFile(record.createdAt);
      await appendJsonLine(filePath, record);
      this.scheduler?.notifyRawEvent?.(record);
      return record.eventId;
    } catch (error) {
      console.error(`[chat-memory] capture failed event=${record?.eventType || ""}: ${error.message}`);
      return "";
    }
  }

  resolveRawFile(createdAt = "") {
    const key = formatDateKey(createdAt || new Date());
    return path.join(this.config.chatMemoryRawDir, `${key}.jsonl`);
  }
}

function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => ({
    kind: normalizeText(item?.kind),
    contentType: normalizeText(item?.contentType),
    sourceFileName: normalizeText(item?.sourceFileName || item?.fileName),
    absolutePath: normalizeText(item?.absolutePath),
    isImage: Boolean(item?.isImage),
  }));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChatCaptureService };
