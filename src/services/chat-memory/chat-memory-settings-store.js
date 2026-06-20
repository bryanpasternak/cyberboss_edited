const { readJsonFile, writeJsonFile } = require("./jsonl");

class ChatMemorySettingsStore {
  constructor({ filePath = "", defaults = {} } = {}) {
    this.filePath = filePath;
    this.defaults = {
      injectEnabled: Boolean(defaults.injectEnabled),
      injectLimit: Number(defaults.injectLimit) || 6,
      ...defaults,
    };
  }

  get() {
    const raw = this.filePath
      ? readJsonFile(this.filePath, {})
      : {};
    return normalizeSettings({
      ...this.defaults,
      ...(raw && typeof raw === "object" ? raw : {}),
    });
  }

  set(next = {}) {
    const settings = normalizeSettings({
      ...this.get(),
      ...(next && typeof next === "object" ? next : {}),
      updatedAt: new Date().toISOString(),
    });
    if (this.filePath) {
      writeJsonFile(this.filePath, settings);
    }
    return settings;
  }

  describe() {
    return this.get();
  }
}

function normalizeSettings(settings = {}) {
  const limit = Number.parseInt(settings.injectLimit, 10);
  return {
    schema: "chat-memory.settings.v1",
    injectEnabled: settings.injectEnabled !== false,
    injectLimit: Number.isFinite(limit) ? Math.max(0, Math.min(20, limit)) : 6,
    updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : "",
  };
}

module.exports = { ChatMemorySettingsStore };
