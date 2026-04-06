const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { resolvePreferredSenderId } = require("../core/default-targets");

const DELAY_UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

async function runReminderWriteCommand(config) {
  const args = process.argv.slice(4);
  const options = parseArgs(args);
  const body = await resolveBody(options);
  if (!body) {
    throw new Error("提醒内容不能为空，传 --text 或通过 stdin 输入");
  }

  const delayMs = parseDelay(options.delay);
  if (!delayMs) {
    throw new Error("缺少有效时长，使用 --delay 30s|10m|2h|1d");
  }

  const account = resolveSelectedAccount(config);
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: options.user,
    sessionStore,
  });
  if (!senderId) {
    throw new Error("无法确定 reminder 的微信用户，传 --user 或先让唯一活跃用户和 bot 聊过一次");
  }

  const contextTokens = loadPersistedContextTokens(config, account.accountId);
  const contextToken = String(contextTokens[senderId] || "").trim();
  if (!contextToken) {
    throw new Error(`找不到 ${senderId} 的 context_token，先让这个用户和 bot 聊过一次`);
  }

  const queue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
  const reminder = queue.enqueue({
    id: crypto.randomUUID(),
    accountId: account.accountId,
    senderId,
    contextToken,
    text: body,
    dueAtMs: Date.now() + delayMs,
    createdAt: new Date().toISOString(),
  });
  console.log(`reminder queued: ${reminder.id}`);
}

function parseArgs(args) {
  const options = {
    delay: "",
    text: "",
    user: "",
    useStdin: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--delay") {
      options.delay = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--text") {
      options.text = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--user") {
      options.user = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--stdin") {
      options.useStdin = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function parseDelay(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*([smhd])$/);
  if (!match) {
    return 0;
  }
  const amount = Number.parseInt(match[1], 10);
  const unitMs = DELAY_UNIT_MS[match[2]] || 0;
  if (!Number.isFinite(amount) || amount <= 0 || !unitMs) {
    return 0;
  }
  return amount * unitMs;
}

async function resolveBody(options) {
  const inlineText = normalizeBody(options.text);
  if (inlineText) {
    return inlineText;
  }
  if (!options.useStdin && process.stdin.isTTY) {
    return "";
  }
  return normalizeBody(await readStdin());
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", reject);
  });
}

function normalizeBody(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

module.exports = { runReminderWriteCommand };
