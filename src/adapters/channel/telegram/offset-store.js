const fs = require("fs");
const path = require("path");

class TelegramOffsetStore {
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
      console.error(`[cyberboss] failed to persist telegram offset: ${error.message}`);
    }
  }

  getOffset(accountId) {
    const key = String(accountId || "default");
    const value = Number(this.state?.[key]?.offset);
    return Number.isFinite(value) ? value : 0;
  }

  setOffset(accountId, offset) {
    const key = String(accountId || "default");
    const numeric = Number(offset);
    if (!Number.isFinite(numeric)) {
      return;
    }
    this.state[key] = { offset: numeric, updatedAt: new Date().toISOString() };
    this.save();
  }
}

module.exports = { TelegramOffsetStore };
