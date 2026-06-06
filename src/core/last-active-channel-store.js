const fs = require("fs");
const path = require("path");

class LastActiveChannelStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
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
      this.state = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      this.state = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.error(`[cyberboss] failed to persist last-active-channel: ${error.message}`);
    }
  }

  mark(senderId, channelId) {
    const normalizedSender = normalizeText(senderId);
    const normalizedChannel = normalizeText(channelId);
    if (!normalizedSender || !normalizedChannel) {
      return;
    }
    this.state[normalizedSender] = {
      channelId: normalizedChannel,
      updatedAt: new Date().toISOString(),
    };
    this.save();
  }

  resolve(senderId) {
    const normalizedSender = normalizeText(senderId);
    if (!normalizedSender) {
      return null;
    }
    const entry = this.state[normalizedSender];
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const channelId = normalizeText(entry.channelId);
    if (!channelId) {
      return null;
    }
    const updatedAt = normalizeText(entry.updatedAt);
    const updatedAtMs = updatedAt ? Date.parse(updatedAt) : 0;
    const ageMs = Number.isFinite(updatedAtMs) && updatedAtMs > 0
      ? Math.max(0, Date.now() - updatedAtMs)
      : null;
    return { channelId, updatedAt, ageMs };
  }

  forget(senderId) {
    const normalizedSender = normalizeText(senderId);
    if (!normalizedSender || !(normalizedSender in this.state)) {
      return;
    }
    delete this.state[normalizedSender];
    this.save();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { LastActiveChannelStore };
