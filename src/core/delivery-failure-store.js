const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_RECORDS = 200;

class DeliveryFailureStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { failures: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const failures = Array.isArray(parsed?.failures) ? parsed.failures : [];
      this.state = {
        failures: failures
          .map(normalizeDeliveryFailure)
          .filter(Boolean)
          .sort(compareFailures)
          .slice(-MAX_RECORDS),
      };
    } catch {
      this.state = { failures: [] };
    }
  }

  save() {
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup only; the canonical queue file remains intact.
      }
    }
  }

  enqueue(failure) {
    this.load();
    const normalized = normalizeDeliveryFailure({
      ...failure,
      id: normalizeText(failure?.id) || crypto.randomUUID(),
    });
    if (!normalized) {
      throw new Error("invalid delivery failure");
    }
    const existing = this.state.failures.find((entry) => entry.key === normalized.key);
    if (existing) {
      return existing;
    }
    this.state.failures.push(normalized);
    this.state.failures.sort(compareFailures);
    this.state.failures = this.state.failures.slice(-MAX_RECORDS);
    this.save();
    return normalized;
  }

  pendingForChannel(channelId, limit = 1) {
    this.load();
    const normalizedChannelId = normalizeText(channelId).toLowerCase();
    const normalizedLimit = Math.max(1, Number(limit) || 1);
    return this.state.failures
      .filter((failure) => failure.channelId === normalizedChannelId && !failure.notifiedAt)
      .slice(0, normalizedLimit);
  }

  markNotified(id, notifiedAt = new Date().toISOString()) {
    this.load();
    const normalizedId = normalizeText(id);
    const failure = this.state.failures.find((entry) => entry.id === normalizedId);
    if (!failure) {
      return false;
    }
    failure.notifiedAt = normalizeIsoTime(notifiedAt) || new Date().toISOString();
    this.save();
    return true;
  }
}

function normalizeDeliveryFailure(failure) {
  if (!failure || typeof failure !== "object") {
    return null;
  }
  const id = normalizeText(failure.id);
  const channelId = normalizeText(failure.channelId).toLowerCase();
  const userId = normalizeText(failure.userId);
  const text = normalizeText(failure.text);
  if (!id || !channelId || !userId || !text) {
    return null;
  }
  const threadId = normalizeText(failure.threadId);
  const turnId = normalizeText(failure.turnId);
  const itemId = normalizeText(failure.itemId);
  return {
    id,
    key: normalizeText(failure.key) || [channelId, threadId, turnId, itemId || id].join(":"),
    channelId,
    userId,
    contextToken: normalizeText(failure.contextToken),
    threadId,
    turnId,
    itemId,
    text,
    kind: normalizeText(failure.kind) || "plain_reply",
    createdAt: normalizeIsoTime(failure.createdAt) || new Date().toISOString(),
    failedAt: normalizeIsoTime(failure.failedAt) || new Date().toISOString(),
    errorName: normalizeText(failure.errorName),
    errorCode: normalizeText(String(failure.errorCode ?? "")),
    lastError: normalizeText(failure.lastError).slice(0, 1000),
    notifiedAt: normalizeIsoTime(failure.notifiedAt),
  };
}

function compareFailures(left, right) {
  const leftTime = Date.parse(left?.failedAt || left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.failedAt || right?.createdAt || "") || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { DeliveryFailureStore };
