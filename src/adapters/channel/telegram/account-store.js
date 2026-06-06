const fs = require("fs");
const path = require("path");

function normalizeAccountId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function ensureAccountsDir(config) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}

function buildAccountFileName(accountId) {
  return `telegram-${normalizeAccountId(accountId)}.json`;
}

function resolveAccountPath(config, accountId) {
  return path.join(config.accountsDir, buildAccountFileName(accountId));
}

function saveTelegramAccount(config, accountId, update) {
  ensureAccountsDir(config);
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    throw new Error("telegram accountId is empty");
  }
  const filePath = resolveAccountPath(config, normalized);
  const existing = loadTelegramAccount(config, normalized) || {};
  const next = {
    accountId: normalized,
    botId: typeof update.botId === "number" ? update.botId : (existing.botId || 0),
    botUsername: typeof update.botUsername === "string" ? update.botUsername.trim() : existing.botUsername || "",
    botToken: typeof update.botToken === "string" && update.botToken.trim()
      ? update.botToken.trim()
      : existing.botToken || "",
    apiBaseUrl: typeof update.apiBaseUrl === "string" && update.apiBaseUrl.trim()
      ? update.apiBaseUrl.trim()
      : existing.apiBaseUrl || config.telegramApiBaseUrl || "https://api.telegram.org",
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return next;
}

function loadTelegramAccount(config, accountId) {
  const normalized = normalizeAccountId(accountId);
  if (!normalized) {
    return null;
  }
  try {
    const raw = fs.readFileSync(resolveAccountPath(config, normalized), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      accountId: normalized,
      botId: typeof parsed.botId === "number" ? parsed.botId : 0,
      botUsername: typeof parsed.botUsername === "string" ? parsed.botUsername : "",
      botToken: typeof parsed.botToken === "string" ? parsed.botToken : "",
      apiBaseUrl: typeof parsed.apiBaseUrl === "string" && parsed.apiBaseUrl.trim()
        ? parsed.apiBaseUrl.trim()
        : config.telegramApiBaseUrl || "https://api.telegram.org",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

function listTelegramAccounts(config) {
  ensureAccountsDir(config);
  const files = fs.readdirSync(config.accountsDir, { withFileTypes: true });
  return files
    .filter((entry) => entry.isFile() && entry.name.startsWith("telegram-") && entry.name.endsWith(".json"))
    .map((entry) => {
      const id = entry.name.slice("telegram-".length, -5);
      return loadTelegramAccount(config, id);
    })
    .filter(Boolean)
    .sort((left, right) => String(right.savedAt || "").localeCompare(String(left.savedAt || "")));
}

function resolveSelectedTelegramAccount(config) {
  const explicit = String(config.telegramBotToken || "").trim();
  if (explicit) {
    return {
      accountId: "env-token",
      botId: 0,
      botUsername: "",
      botToken: explicit,
      apiBaseUrl: config.telegramApiBaseUrl || "https://api.telegram.org",
      savedAt: "",
    };
  }
  const accounts = listTelegramAccounts(config);
  if (!accounts.length) {
    throw new Error("No saved Telegram bot was found. Run `cyberboss login --channel telegram` first.");
  }
  if (accounts.length > 1) {
    const accountIds = accounts.map((account) => account.accountId).join(", ");
    throw new Error(`Multiple Telegram bots were detected. Set CYBERBOSS_TELEGRAM_ACCOUNT_ID. Available: ${accountIds}`);
  }
  return accounts[0];
}

module.exports = {
  listTelegramAccounts,
  loadTelegramAccount,
  normalizeAccountId,
  resolveSelectedTelegramAccount,
  saveTelegramAccount,
};
