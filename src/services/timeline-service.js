const crypto = require("crypto");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { resolvePreferredSenderId } = require("../core/default-targets");
const { TimelineScreenshotQueueStore } = require("../core/timeline-screenshot-queue-store");

class TimelineService {
  constructor({ config, timelineIntegration, sessionStore }) {
    this.config = config;
    this.timelineIntegration = timelineIntegration;
    this.sessionStore = sessionStore;
    this.screenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
  }

  async write({ date = "", eventsJson = "", eventsFile = "", locale = "" } = {}) {
    const args = [];
    if (date) {
      args.push("--date", date);
    }
    if (locale) {
      args.push("--locale", locale);
    }
    if (eventsFile) {
      args.push("--events-file", eventsFile);
    } else if (eventsJson) {
      args.push("--events-json", eventsJson);
    }
    await this.timelineIntegration.runSubcommand("write", args);
    return {
      subcommand: "write",
      args,
    };
  }

  async build({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    await this.timelineIntegration.runSubcommand("build", args);
    return { subcommand: "build", args };
  }

  async serve({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    await this.timelineIntegration.runSubcommand("serve", args);
    return { subcommand: "serve", args };
  }

  async dev({ locale = "" } = {}) {
    const args = locale ? ["--locale", locale] : [];
    await this.timelineIntegration.runSubcommand("dev", args);
    return { subcommand: "dev", args };
  }

  queueScreenshot({ userId = "", outputFile = "", locale = "", args = [] } = {}, context = {}) {
    const account = resolveSelectedAccount(this.config);
    const senderId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });

    if (!senderId) {
      throw new Error("Missing send target for timeline screenshot.");
    }

    const forwardArgs = Array.isArray(args)
      ? args.map((value) => String(value ?? "")).filter(Boolean)
      : [];
    if (locale) {
      forwardArgs.push("--locale", locale);
    }
    const queued = this.screenshotQueue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId,
      outputFile: normalizeText(outputFile) ? path.resolve(outputFile) : "",
      args: forwardArgs,
      createdAt: new Date().toISOString(),
    });
    return queued;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TimelineService };
