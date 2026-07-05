const { getShanghaiParts, withShanghaiTime, addDaysShanghai } = require("./time");

class ChatMemoryScheduler {
  constructor({ config = {}, chunker = null, summarizer = null } = {}) {
    this.config = config;
    this.chunker = chunker;
    this.summarizer = summarizer;
    this.idleTimer = null;
    this.cronTimer = null;
    this.lastRawEventAtMs = 0;
    this.enabled = Boolean(config.chatMemoryEnabled);
    this.useDeepSeek = Boolean(config.chatMemoryDeepSeekEnabled) && Boolean(summarizer);
    this.cronHours = Array.isArray(config.chatMemoryCronHours) && config.chatMemoryCronHours.length
      ? config.chatMemoryCronHours
      : [3, 15];
  }

  start() {
    if (!this.enabled) {
      return;
    }
    // 启动时处理遗漏日志
    void this.processStartupDueLogs().catch((error) => {
      console.warn(`[chat-memory] startup processing failed: ${error.message}`);
    });
    // 启动 cron 定时器
    this.scheduleNextCron();
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.cronTimer) {
      clearTimeout(this.cronTimer);
      this.cronTimer = null;
    }
  }

  notifyRawEvent(record = {}) {
    if (!this.enabled) {
      return;
    }
    this.lastRawEventAtMs = Date.parse(record.createdAt || "") || Date.now();
    this.scheduleIdleProcessing();
  }

  // ─── idle 调度（保留原有逻辑） ──────────────────────────────

  scheduleIdleProcessing() {
    if (!this.chunker) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    const delayMs = Math.max(0, Number(this.config.chatMemoryIdleMs) || 30 * 60_000);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
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
    // 启动时：如果有 DeepSeek summarizer 且启用，优先用 summarizer
    // 否则回退到旧 chunker
    if (this.useDeepSeek && this.summarizer) {
      // 检查是否有遗漏的 cron 窗口需要补偿
      await this.processMissedCronIfNeeded();
      return await this.summarizer.processDueLogs({ reason: "startup", now: new Date(), force: true });
    }
    if (this.chunker) {
      return await this.chunker.processDueLogs({ reason: "startup", now: new Date(), force: true });
    }
    return { processedFiles: 0, chunks: 0 };
  }

  // ─── cron 调度 ─────────────────────────────────────────────

  /**
   * 计算下一个 cron 触发时间（上海时区）。
   * 在 cronHours 中找今天尚未过的时间；如果都已过，取明天的第一个。
   */
  calculateNextFireTime(now = new Date()) {
    const parts = getShanghaiParts(now);
    const sorted = [...this.cronHours].sort((a, b) => a - b);

    // 找今天第一个尚未过的时间点
    for (const hour of sorted) {
      if (hour > parts.hour || (hour === parts.hour && parts.minute < 1)) {
        return withShanghaiTime(now, hour, 0, 0);
      }
    }

    // 都已过，取明天的第一个
    const tomorrow = addDaysShanghai(now, 1);
    return withShanghaiTime(tomorrow, sorted[0], 0, 0);
  }

  scheduleNextCron() {
    if (this.cronTimer) {
      clearTimeout(this.cronTimer);
    }
    const next = this.calculateNextFireTime();
    const delayMs = Math.max(1000, next.getTime() - Date.now());

    // 防止 setTimeout 溢出（超过 ~24.8 天），虽然 cron 每天至少触发一次
    const clampedMs = Math.min(delayMs, 24 * 60 * 60_000);

    this.cronTimer = setTimeout(() => {
      this.cronTimer = null;
      void this.processCronTrigger().catch((error) => {
        console.warn(`[chat-memory] cron processing failed: ${error.message}`);
      });
    }, clampedMs);

    const parts = getShanghaiParts(next);
    console.warn(
      `[chat-memory] next cron: ${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} (in ${Math.round(delayMs / 60_000)} min)`
    );
  }

  async processCronTrigger() {
    if (this.useDeepSeek && this.summarizer) {
      await this.summarizer.processDueLogs({ reason: "cron", now: new Date() });
    } else if (this.chunker) {
      await this.chunker.processDueLogs({ reason: "cron", now: new Date() });
    }
    // 安排下一次
    this.scheduleNextCron();
  }

  /**
   * 检查是否错过了上次 cron 窗口。
   * 如果当前时间超过了最近一个 cron 窗口 + 1 小时容差，执行补偿。
   */
  async processMissedCronIfNeeded() {
    if (!this.summarizer) {
      return;
    }
    // 找最近一个应该已经触发的 cron 时间
    const now = new Date();
    const parts = getShanghaiParts(now);
    const sorted = [...this.cronHours].sort((a, b) => b - a); // 降序，找最近的

    let lastCronHour = null;
    for (const hour of sorted) {
      if (hour <= parts.hour) {
        lastCronHour = hour;
        break;
      }
    }
    // 如果今天的都已过，取昨天的最后一个
    if (lastCronHour === null) {
      lastCronHour = sorted[0]; // 取最大的（降序排的第一个）
      const yesterday = addDaysShanghai(now, -1);
      const lastCron = withShanghaiTime(yesterday, lastCronHour, 0, 0);
      const hoursSince = (now.getTime() - lastCron.getTime()) / 3_600_000;
      if (hoursSince > 25) {
        // 超过 25 小时，说明可能是首次启动或长期停运后恢复
        // 仍然处理，但标注 reason 为 "startup-catchup"
        return;
      }
      return;
    }

    const lastCron = withShanghaiTime(now, lastCronHour, 0, 0);
    const hoursSince = (now.getTime() - lastCron.getTime()) / 3_600_000;

    // 如果当前时间在 cron 窗口后 1 小时内，且不是 startup force 触发的，
    // 说明是正常窗口内的 startup，不需要补偿
    // 如果超过 1 小时，说明错过了，但 startup 已经 force=true 处理了
  }
}

module.exports = { ChatMemoryScheduler };
