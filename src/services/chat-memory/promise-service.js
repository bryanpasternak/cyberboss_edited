const crypto = require("crypto");
const path = require("path");

const { appendJsonLine, ensureParentDirectory, readJsonFile, writeJsonFile } = require("./jsonl");
const { parsePromiseDue } = require("./promise-time");
const { formatLocalMinute, getShanghaiParts, normalizeIsoTime } = require("./time");

class PromiseService {
  constructor({ config = {}, systemMessageQueue = null, classifier = null } = {}) {
    this.config = config;
    this.systemMessageQueue = systemMessageQueue;
    this.classifier = classifier;
    this.enabled = Boolean(config.promiseMemoryEnabled);
  }

  async captureAssistantPromise({
    threadId = "",
    turnId = "",
    text = "",
    bindingKey = "",
    workspaceRoot = "",
    accountId = "",
    senderId = "",
    source = {},
  } = {}) {
    if (!this.enabled) {
      return [];
    }
    const normalized = String(text || "").trim();
    if (!normalized) {
      return [];
    }
    const candidates = extractPromiseCandidates(normalized, { promisor: "assistant", madeAt: new Date(), source });
    const confirmed = await this.applyClassifier(candidates);
    const created = [];
    for (const candidate of confirmed) {
      const promise = this.normalizePromise({
        ...candidate,
        source: {
          threadId,
          turnId,
          ...source,
        },
        bindingKey,
        workspaceRoot,
        accountId,
        senderId,
      });
      if (!promise) {
        continue;
      }
      const stored = this.upsertPromise(promise);
      created.push(stored);
    }
    return created;
  }

  async captureUserPromise(args = {}) {
    if (!this.enabled) {
      return [];
    }
    const text = String(args?.text || "").trim();
    const candidates = extractPromiseCandidates(text, { promisor: "user", madeAt: new Date(), source: args?.source || {} });
    const confirmed = await this.applyClassifier(candidates);
    const created = [];
    for (const candidate of confirmed) {
      const promise = this.normalizePromise({
        ...candidate,
        source: args?.source || {},
        bindingKey: args?.bindingKey,
        workspaceRoot: args?.workspaceRoot,
        accountId: args?.accountId,
        senderId: args?.senderId,
      });
      if (!promise) {
        continue;
      }
      created.push(this.upsertPromise(promise));
    }
    return created;
  }

  async applyClassifier(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) {
      return [];
    }
    if (!this.classifier?.isReady?.()) {
      return candidates;
    }
    const verdicts = await Promise.all(candidates.map((candidate) => this.classifier
      .classify({ text: candidate.text, promisor: candidate.promisor, dueType: candidate.dueType })
      .catch(() => null)));
    const passed = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const verdict = verdicts[index];
      if (!verdict) {
        passed.push(candidate);
        continue;
      }
      if (verdict.isPromise === false) {
        continue;
      }
      if (Number.isFinite(verdict.confidence) && verdict.confidence > 0) {
        candidate.confidence = verdict.confidence;
      }
      passed.push(candidate);
    }
    return passed;
  }

  getOpenPromises() {
    const state = this.readState();
    return Array.isArray(state.open) ? state.open : [];
  }

  retrieveDueForTurn({
    now = new Date(),
    bindingKey = "",
    workspaceRoot = "",
    accountId = "",
    senderId = "",
    limit = 2,
  } = {}) {
    if (!this.enabled) {
      return [];
    }
    const current = now instanceof Date ? now : new Date(now);
    this.sweepStalePromises(current);
    const maxInjects = this.getMaxInjectCount();
    const open = this.getOpenPromises();
    return open
      .filter((promise) => this.matchesBinding(promise, bindingKey, workspaceRoot, accountId, senderId))
      .filter((promise) => this.isDue(promise, current))
      .filter((promise) => Number(promise.injectCount || 0) < maxInjects)
      .filter((promise) => !this.isRecentlyInjected(promise, current, this.getInjectCooldownMs(promise)))
      .sort((left, right) => (right.confidence || 0) - (left.confidence || 0))
      .slice(0, Math.max(0, Number(limit) || 0));
  }

  sweepStalePromises(now = new Date()) {
    if (!this.enabled) {
      return [];
    }
    const current = now instanceof Date ? now : new Date(now);
    const maxInjects = this.getMaxInjectCount();
    const graceMs = this.getExpiredGraceMs();
    const open = this.getOpenPromises();
    const archived = [];
    for (const promise of open) {
      if (Number(promise.injectCount || 0) >= maxInjects) {
        archived.push({ id: promise.id, status: "stale", closeReason: "max_injects" });
        continue;
      }
      if (promise.dueType === "next_time") {
        continue;
      }
      const windowEnd = Date.parse(promise.dueWindowEndAt || promise.dueAt || "");
      if (Number.isFinite(windowEnd) && current.getTime() - windowEnd > graceMs) {
        archived.push({ id: promise.id, status: "stale", closeReason: "expired" });
      }
    }
    for (const item of archived) {
      this.archiveFulfilledPromise(item.id, { status: item.status, closeReason: item.closeReason });
    }
    return archived;
  }

  formatDueForInjection(promises = [], { title = "我和苏苏之间还有一些约定：" } = {}) {
    if (!Array.isArray(promises) || !promises.length) {
      return "";
    }
    const lines = [title];
    for (const promise of promises) {
      const madeAt = formatLocalMinute(promise.madeAt);
      const dueAt = promise.dueAt ? `，说好了 ${formatLocalMinute(promise.dueAt)}` : "";
      lines.push(`我答应过苏苏 ${madeAt}${dueAt}——${normalizeText(promise.text)}`.trim());
    }
    lines.push("如果这个约定应该兑现，可以自然地提起它，否则暂时忽略它。");
    return lines.join("\n");
  }

  maybeQueueActiveCheck(promise) {
    if (!this.enabled || !Boolean(this.config.promiseActiveTriggerEnabled)) {
      return null;
    }
    if (!this.systemMessageQueue || !promise?.id) {
      return null;
    }
    const text = buildPromiseSystemText(promise);
    const queued = this.systemMessageQueue.enqueue({
      id: `promise:${promise.id}:${Date.now()}`,
      accountId: normalizeText(promise.accountId),
      senderId: normalizeText(promise.senderId),
      workspaceRoot: normalizeText(promise.workspaceRoot),
      text,
      createdAt: new Date().toISOString(),
    });
    this.markInjected([promise.id], { at: new Date() });
    return queued;
  }

  markInjected(promiseIds = [], { at = new Date() } = {}) {
    if (!this.enabled) {
      return [];
    }
    const ids = new Set((Array.isArray(promiseIds) ? promiseIds : []).map((id) => normalizeText(id)).filter(Boolean));
    if (!ids.size) {
      return [];
    }
    const state = this.readState();
    const open = Array.isArray(state.open) ? state.open : [];
    const updated = [];
    const stampedAt = normalizeIsoTime(at, new Date().toISOString());
    for (const item of open) {
      if (!ids.has(item.id)) {
        continue;
      }
      item.lastInjectedAt = stampedAt;
      item.injectCount = Number(item.injectCount || 0) + 1;
      updated.push(item);
    }
    if (updated.length) {
      state.open = open;
      this.writeState(state);
    }
    return updated;
  }

  archiveFulfilledPromise(promiseId, extra = {}) {
    const state = this.readState();
    const open = Array.isArray(state.open) ? state.open : [];
    const remaining = [];
    let moved = null;
    for (const item of open) {
      if (item.id === promiseId && !moved) {
        moved = {
          ...item,
          status: "closed",
          closedAt: new Date().toISOString(),
          ...extra,
        };
        continue;
      }
      remaining.push(item);
    }
    if (moved) {
      state.open = remaining;
      state.archive = Array.isArray(state.archive) ? state.archive : [];
      state.archive.push(moved);
      this.writeState(state);
      this.appendArchiveRecord(moved);
    }
    return moved;
  }

  readState() {
    return readJsonFile(this.config.promiseStoreFile, {
      schema: "chat-memory.promise-store.v1",
      open: [],
      archive: [],
    });
  }

  writeState(state) {
    ensureParentDirectory(this.config.promiseStoreFile);
    writeJsonFile(this.config.promiseStoreFile, state);
  }

  appendArchiveRecord(record) {
    if (!record || !this.config.promiseArchiveFile) {
      return;
    }
    const archivePath = this.config.promiseArchiveFile;
    ensureParentDirectory(archivePath);
    appendJsonLine(archivePath, record).catch(() => {});
  }

  normalizePromise(candidate) {
    const due = candidate.due || parsePromiseDue(candidate.text || "", candidate.madeAt || new Date());
    const dueAt = normalizeIsoTime(candidate.dueAt || due?.dueAt, "");
    const confidence = clamp(Number(candidate.confidence) || 0.78, 0, 1);
    const text = normalizeText(candidate.text);
    if (!text) {
      return null;
    }
    return {
      schema: "chat-memory.promise.v1",
      id: normalizeText(candidate.id) || `prom_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
      status: "open",
      promisor: normalizeText(candidate.promisor) || "assistant",
      promisee: normalizeText(candidate.promisee) || "user",
      text,
      madeAt: normalizeIsoTime(candidate.madeAt, new Date().toISOString()),
      dueAt,
      dueWindowStartAt: normalizeIsoTime(candidate.dueWindowStartAt || due?.dueWindowStartAt, ""),
      dueWindowEndAt: normalizeIsoTime(candidate.dueWindowEndAt || due?.dueWindowEndAt, ""),
      dueType: normalizeText(candidate.dueType) || normalizeText(due?.dueType) || "next_time",
      confidence,
      source: candidate.source && typeof candidate.source === "object" ? candidate.source : {},
      tags: Array.isArray(candidate.tags) ? candidate.tags.filter(Boolean).map(String) : [],
      lastInjectedAt: normalizeText(candidate.lastInjectedAt),
      injectCount: Number.isInteger(candidate.injectCount) ? candidate.injectCount : 0,
      bindingKey: normalizeText(candidate.bindingKey),
      workspaceRoot: normalizeText(candidate.workspaceRoot),
      accountId: normalizeText(candidate.accountId),
      senderId: normalizeText(candidate.senderId),
    };
  }

  getInjectCooldownMs(promise = null) {
    const dueType = String(promise?.dueType || "").toLowerCase();
    if (dueType === "next_time") {
      return Math.max(0, Number(this.config.promiseNextTimeCooldownMs) || 6 * 60 * 60_000);
    }
    return Math.max(0, Number(this.config.promiseInjectCooldownMs) || 30 * 60_000);
  }

  getMaxInjectCount() {
    return Math.max(1, Number(this.config.promiseMaxInjectCount) || 3);
  }

  getExpiredGraceMs() {
    return Math.max(0, Number(this.config.promiseExpiredGraceMs) || 12 * 60 * 60_000);
  }

  isRecentlyInjected(promise, now, cooldownMs) {
    const injectedAt = Date.parse(promise?.lastInjectedAt || "");
    if (!Number.isFinite(injectedAt)) {
      return false;
    }
    return now.getTime() - injectedAt < Math.max(0, Number(cooldownMs) || 0);
  }

  upsertPromise(promise) {
    const state = this.readState();
    const open = Array.isArray(state.open) ? state.open : [];
    const existingIndex = open.findIndex((item) => item.id === promise.id || (
      item.text === promise.text
      && item.promisor === promise.promisor
      && item.dueType === promise.dueType
      && item.bindingKey === promise.bindingKey
      && item.workspaceRoot === promise.workspaceRoot
    ));
    if (existingIndex >= 0) {
      open[existingIndex] = {
        ...open[existingIndex],
        ...promise,
        injectCount: Number(open[existingIndex].injectCount || 0),
      };
      state.open = open;
      this.writeState(state);
      return open[existingIndex];
    }
    open.push({
      ...promise,
      injectCount: 0,
      lastInjectedAt: "",
    });
    state.open = open;
    this.writeState(state);
    return promise;
  }

  matchesBinding(promise, bindingKey, workspaceRoot, accountId = "", senderId = "") {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const normalizedAccountId = normalizeText(accountId);
    const normalizedSenderId = normalizeText(senderId);
    if (promise.bindingKey && normalizedBindingKey && promise.bindingKey !== normalizedBindingKey) {
      return false;
    }
    if (promise.workspaceRoot && normalizedWorkspaceRoot && promise.workspaceRoot !== normalizedWorkspaceRoot) {
      return false;
    }
    if (promise.accountId && normalizedAccountId && promise.accountId !== normalizedAccountId) {
      return false;
    }
    if (promise.senderId && normalizedSenderId && promise.senderId !== normalizedSenderId) {
      return false;
    }
    return true;
  }

  isDue(promise, now) {
    if (promise.dueType === "next_time") {
      return isWithinHourWindows(now, this.getNextTimeWindows());
    }
    const dueAt = Date.parse(promise.dueAt || "");
    if (Number.isFinite(dueAt) && dueAt <= now.getTime()) {
      return true;
    }
    const windowStart = Date.parse(promise.dueWindowStartAt || "");
    const windowEnd = Date.parse(promise.dueWindowEndAt || "");
    if (Number.isFinite(windowStart) && Number.isFinite(windowEnd)) {
      return now.getTime() >= windowStart && now.getTime() <= windowEnd;
    }
    return false;
  }

  getNextTimeWindows() {
    return parseHourWindows(this.config.promiseNextTimeWindowHours);
  }
}

function parseHourWindows(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || /^(off|none|disabled)$/i.test(text)) {
    return [];
  }
  const windows = [];
  for (const segment of text.split(",")) {
    const part = segment.trim();
    if (!part) {
      continue;
    }
    const match = part.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!match) {
      continue;
    }
    const start = clamp(Number(match[1]), 0, 24);
    const end = clamp(Number(match[2]), 0, 24);
    if (end <= start) {
      continue;
    }
    windows.push([start, end]);
  }
  return windows;
}

function isWithinHourWindows(now, windows) {
  if (!Array.isArray(windows) || !windows.length) {
    return true;
  }
  const hour = getShanghaiParts(now instanceof Date ? now : new Date(now)).hour;
  return windows.some(([start, end]) => hour >= start && hour < end);
}

function extractPromiseCandidates(text, { promisor = "assistant", madeAt = new Date(), source = {} } = {}) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }
  const due = parsePromiseDue(normalized, madeAt);
  if (!due) {
    return [];
  }
  const confidence = promisor === "assistant" ? 0.86 : 0.72;
  return [{
    promisor,
    promisee: promisor === "assistant" ? "user" : "assistant",
    text: normalized,
    madeAt,
    confidence,
    source,
    ...due,
    tags: inferPromiseTags(normalized),
  }];
}

function inferPromiseTags(text) {
  const tags = new Set(["promise"]);
  if (/今晚|明早/.test(text)) tags.add("time");
  if (/账上|记账|记着账|收账|记你账|记我账/.test(text)) tags.add("relationship");
  if (/歘/.test(text)) tags.add("task");
  return [...tags];
}

function buildPromiseSystemText(promise) {
  return [
    "SYSTEM PROMISE CHECK",
    `Promise: ${normalizeText(promise.text)}`,
    `Due type: ${normalizeText(promise.dueType) || "next_time"}`,
    `Due at: ${normalizeText(promise.dueAt) || "(unscheduled)"}`,
    "Check whether this promise is now due or should be acted on. If due, continue naturally without mentioning internal scheduling.",
  ].join("\n");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  PromiseService,
  extractPromiseCandidates,
  buildPromiseSystemText,
};
