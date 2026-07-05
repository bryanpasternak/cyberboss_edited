const fs = require("fs");
const crypto = require("crypto");

/**
 * Midnight trigger service.
 * After 3 AM Asia/Shanghai each day, fires a one-shot system trigger
 * to remind the model to do things. Fires at most once per calendar day.
 */
class MidnightTrigger {
  /**
   * @param {object} options
   * @param {string} options.triggerFile - path to the midnight trigger text file
   * @param {object} options.systemMessageQueue - SystemMessageQueueStore instance
   * @param {object} options.config - the app config
   * @param {string} options.accountId - active account ID
   * @param {string} options.senderId - target sender ID
   * @param {string} options.workspaceRoot - target workspace root
   */
  constructor({ triggerFile = "", systemMessageQueue = null, config = {}, accountId = "", senderId = "", workspaceRoot = "" }) {
    this._triggerFile = normalizeText(triggerFile);
    this._queue = systemMessageQueue;
    this._config = config;
    this._accountId = normalizeText(accountId);
    this._senderId = normalizeText(senderId);
    this._workspaceRoot = normalizeText(workspaceRoot);
  }

  /**
   * Update the target sender/workspace (called when these become available).
   */
  updateTarget({ senderId = "", workspaceRoot = "" } = {}) {
    const newSenderId = normalizeText(senderId);
    const newWorkspaceRoot = normalizeText(workspaceRoot);
    if (newSenderId) {
      this._senderId = newSenderId;
    }
    if (newWorkspaceRoot) {
      this._workspaceRoot = newWorkspaceRoot;
    }
  }

  /**
   * Check if the midnight trigger should fire now.
   * Call this periodically (e.g., in the main poll loop).
   * Safe to call frequently — it only fires once per calendar day.
   *
   * @param {object} options
   * @param {Date} [options.now] - current time (for testing)
   * @returns {boolean} true if a trigger was enqueued
   */
  checkAndFire({ now = new Date() } = {}) {
    if (!this._queue || !this._senderId || !this._workspaceRoot || !this._accountId) {
      return false;
    }

    // Only fire after 3 AM Asia/Shanghai
    if (!isPastTriggerHour(now)) {
      return false;
    }

    // Only fire once per calendar day
    const todayKey = formatDateKey(now);
    if (this._lastFiredDate === todayKey) {
      return false;
    }

    // Read the trigger text
    const triggerText = this._readTriggerText();
    if (!triggerText) {
      // Mark as fired even if no text, to avoid repeated file-read failures
      this._lastFiredDate = todayKey;
      return false;
    }

    // Enqueue the system message
    try {
      this._queue.enqueue({
        id: `midnight:${todayKey}:${crypto.randomUUID().slice(0, 8)}`,
        accountId: this._accountId,
        senderId: this._senderId,
        workspaceRoot: this._workspaceRoot,
        text: triggerText,
        createdAt: now.toISOString(),
      });
      this._lastFiredDate = todayKey;
      console.log(`[midnight-trigger] fired date=${todayKey}`);
      return true;
    } catch (err) {
      console.error(`[midnight-trigger] enqueue failed: ${err.message}`);
      return false;
    }
  }

  _readTriggerText() {
    if (!this._triggerFile) {
      return "";
    }
    try {
      const content = fs.readFileSync(this._triggerFile, "utf8").trim();
      // Skip template placeholder
      if (!content || content.startsWith("（在这里写")) {
        return "";
      }
      return content;
    } catch {
      return "";
    }
  }
}

// ---- helpers ----

/** 3 AM in Asia/Shanghai */
const TRIGGER_HOUR = 3;

/**
 * Check if the current time is past the trigger hour in Asia/Shanghai.
 */
function isPastTriggerHour(date) {
  try {
    const timeStr = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false,
    }).format(date);
    const hour = parseInt(timeStr, 10);
    return Number.isFinite(hour) && hour >= TRIGGER_HOUR;
  } catch {
    // Fallback: use local hour
    return date.getHours() >= TRIGGER_HOUR;
  }
}

/**
 * Format a date as YYYY-MM-DD in Asia/Shanghai timezone.
 */
function formatDateKey(date) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date).replace(/\//g, "-");
  } catch {
    // Fallback: use local date
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { MidnightTrigger };
