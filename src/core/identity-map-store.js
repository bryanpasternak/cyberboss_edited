const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LINK_CODE_TTL_MS = 10 * 60_000;

class IdentityMapStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {
      bindings: {},
      pendingCodes: {},
    };
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
      this.state = normalizePersistedState(parsed);
    } catch {
      this.state = { bindings: {}, pendingCodes: {} };
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error(`[cyberboss] failed to persist identity-map: ${error.message}`);
    }
  }

  resolveCanonicalSenderId({ channel, externalId }) {
    const channelId = normalizeText(channel);
    const normalizedExternal = normalizeText(externalId);
    if (!channelId || !normalizedExternal) {
      return "";
    }
    const key = buildBindingKey(channelId, normalizedExternal);
    const entry = this.state.bindings[key];
    return entry && typeof entry === "object" ? normalizeText(entry.canonicalSenderId) : "";
  }

  resolveCanonical({ channel, externalId }) {
    const channelId = normalizeText(channel);
    const normalizedExternal = normalizeText(externalId);
    if (!channelId || !normalizedExternal) {
      return null;
    }
    const key = buildBindingKey(channelId, normalizedExternal);
    const entry = this.state.bindings[key];
    if (!entry || typeof entry !== "object") return null;
    return {
      senderId: normalizeText(entry.canonicalSenderId),
      accountId: normalizeText(entry.canonicalAccountId),
    };
  }

  listBindingsForCanonical(canonicalSenderId) {
    const normalizedCanonical = normalizeText(canonicalSenderId);
    if (!normalizedCanonical) {
      return [];
    }
    return Object.entries(this.state.bindings)
      .filter(([, entry]) => entry && entry.canonicalSenderId === normalizedCanonical)
      .map(([key, entry]) => ({
        channel: entry.channel,
        externalId: entry.externalId,
        boundAt: entry.boundAt,
        bindingKey: key,
      }));
  }

  link({ channel, externalId, canonicalSenderId, canonicalAccountId = "", metadata = {} }) {
    const channelId = normalizeText(channel);
    const normalizedExternal = normalizeText(externalId);
    const normalizedCanonical = normalizeText(canonicalSenderId);
    if (!channelId || !normalizedExternal || !normalizedCanonical) {
      return false;
    }
    const key = buildBindingKey(channelId, normalizedExternal);
    this.state.bindings[key] = {
      channel: channelId,
      externalId: normalizedExternal,
      canonicalSenderId: normalizedCanonical,
      canonicalAccountId: normalizeText(canonicalAccountId),
      boundAt: new Date().toISOString(),
      metadata: metadata && typeof metadata === "object" ? sanitizeMetadata(metadata) : {},
    };
    this.save();
    return true;
  }

  unlink({ channel, externalId }) {
    const channelId = normalizeText(channel);
    const normalizedExternal = normalizeText(externalId);
    if (!channelId || !normalizedExternal) {
      return false;
    }
    const key = buildBindingKey(channelId, normalizedExternal);
    if (!(key in this.state.bindings)) {
      return false;
    }
    delete this.state.bindings[key];
    this.save();
    return true;
  }

  unlinkAllForCanonical(canonicalSenderId) {
    const normalizedCanonical = normalizeText(canonicalSenderId);
    if (!normalizedCanonical) {
      return 0;
    }
    let removed = 0;
    for (const [key, entry] of Object.entries(this.state.bindings)) {
      if (entry && entry.canonicalSenderId === normalizedCanonical) {
        delete this.state.bindings[key];
        removed += 1;
      }
    }
    if (removed) {
      this.save();
    }
    return removed;
  }

  issueLinkCode({ canonicalSenderId, canonicalAccountId = "", channel = "", ttlMs = LINK_CODE_TTL_MS } = {}) {
    this.purgeExpiredCodes();
    const normalizedCanonical = normalizeText(canonicalSenderId);
    if (!normalizedCanonical) {
      return null;
    }
    const code = generateLinkCode();
    const expiresAtMs = Date.now() + Math.max(60_000, Number(ttlMs) || LINK_CODE_TTL_MS);
    this.state.pendingCodes[code] = {
      canonicalSenderId: normalizedCanonical,
      canonicalAccountId: normalizeText(canonicalAccountId),
      channel: normalizeText(channel),
      issuedAt: new Date().toISOString(),
      expiresAtMs,
    };
    this.save();
    return { code, expiresAtMs };
  }

  consumeLinkCode(code) {
    this.purgeExpiredCodes();
    const normalizedCode = normalizeText(code).toUpperCase();
    if (!normalizedCode) {
      return null;
    }
    const entry = this.state.pendingCodes[normalizedCode];
    if (!entry) {
      return null;
    }
    delete this.state.pendingCodes[normalizedCode];
    this.save();
    if (!entry.expiresAtMs || entry.expiresAtMs < Date.now()) {
      return null;
    }
    return {
      canonicalSenderId: entry.canonicalSenderId,
      canonicalAccountId: entry.canonicalAccountId || "",
      channel: entry.channel,
      issuedAt: entry.issuedAt,
    };
  }

  purgeExpiredCodes() {
    const now = Date.now();
    let mutated = false;
    for (const [code, entry] of Object.entries(this.state.pendingCodes)) {
      if (!entry || !entry.expiresAtMs || entry.expiresAtMs < now) {
        delete this.state.pendingCodes[code];
        mutated = true;
      }
    }
    if (mutated) {
      this.save();
    }
  }
}

function generateLinkCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let index = 0; index < 6; index += 1) {
    out += alphabet[bytes[index] % alphabet.length];
  }
  return out;
}

function buildBindingKey(channel, externalId) {
  return `${channel}::${externalId}`;
}

function normalizePersistedState(value) {
  const out = { bindings: {}, pendingCodes: {} };
  if (!value || typeof value !== "object") {
    return out;
  }
  if (value.bindings && typeof value.bindings === "object") {
    for (const [key, entry] of Object.entries(value.bindings)) {
      if (!entry || typeof entry !== "object") continue;
      const channel = normalizeText(entry.channel);
      const externalId = normalizeText(entry.externalId);
      const canonicalSenderId = normalizeText(entry.canonicalSenderId);
      if (!channel || !externalId || !canonicalSenderId) continue;
      out.bindings[key] = {
        channel,
        externalId,
        canonicalSenderId,
        canonicalAccountId: normalizeText(entry.canonicalAccountId),
        boundAt: normalizeText(entry.boundAt),
        metadata: entry.metadata && typeof entry.metadata === "object" ? sanitizeMetadata(entry.metadata) : {},
      };
    }
  }
  if (value.pendingCodes && typeof value.pendingCodes === "object") {
    for (const [code, entry] of Object.entries(value.pendingCodes)) {
      if (!entry || typeof entry !== "object") continue;
      const canonicalSenderId = normalizeText(entry.canonicalSenderId);
      const expiresAtMs = Number(entry.expiresAtMs);
      if (!canonicalSenderId || !Number.isFinite(expiresAtMs)) continue;
      out.pendingCodes[code.toUpperCase()] = {
        canonicalSenderId,
        canonicalAccountId: normalizeText(entry.canonicalAccountId),
        channel: normalizeText(entry.channel),
        issuedAt: normalizeText(entry.issuedAt),
        expiresAtMs,
      };
    }
  }
  return out;
}

function sanitizeMetadata(metadata) {
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { IdentityMapStore, LINK_CODE_TTL_MS };
