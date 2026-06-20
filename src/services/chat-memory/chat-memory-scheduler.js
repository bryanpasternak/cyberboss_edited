class ChatMemoryScheduler {
  constructor({ config = {}, chunker = null } = {}) {
    this.config = config;
    this.chunker = chunker;
    this.timer = null;
    this.lastRawEventAtMs = 0;
    this.enabled = Boolean(config.chatMemoryEnabled);
  }

  start() {
    if (!this.enabled) {
      return;
    }
    void this.processStartupDueLogs().catch((error) => {
      console.warn(`[chat-memory] startup processing failed: ${error.message}`);
    });
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  notifyRawEvent(record = {}) {
    if (!this.enabled) {
      return;
    }
    this.lastRawEventAtMs = Date.parse(record.createdAt || "") || Date.now();
    this.scheduleIdleProcessing();
  }

  scheduleIdleProcessing() {
    if (!this.chunker) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delayMs = Math.max(0, Number(this.config.chatMemoryIdleMs) || 30 * 60_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      const elapsed = Date.now() - this.lastRawEventAtMs;
      if (elapsed < delayMs) {
        this.scheduleIdleProcessing();
        return;
      }
      void this.chunker.processDueLogs({ reason: "idle" }).catch((error) => {
        console.warn(`[chat-memory] idle processing failed: ${error.message}`);
      });
    }, delayMs);
  }

  async processStartupDueLogs() {
    if (!this.chunker) {
      return { processedFiles: 0, chunks: 0 };
    }
    return await this.chunker.processDueLogs({ reason: "startup", now: new Date(), force: true });
  }
}

module.exports = { ChatMemoryScheduler };
