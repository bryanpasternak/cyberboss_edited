const fs = require("fs/promises");
const path = require("path");
const { resolveSelectedTelegramAccount } = require("./account-store");
const { runTelegramLoginFlow } = require("./login");
const { createInboundFilter } = require("./message-utils");
const { TelegramOffsetStore } = require("./offset-store");
const {
  getUpdates,
  sendChatAction,
  sendDocument,
  sendMessage,
  sendPhoto,
} = require("./api");

const DEFAULT_LONG_POLL_TIMEOUT_S = 30;
const MAX_TELEGRAM_TEXT_BYTES = 4096;
const SEND_MESSAGE_INTERVAL_MS = 350;

function createTelegramChannelAdapter(config, { identityMapStore = null } = {}) {
  let selectedAccount = null;
  const inboundFilter = createInboundFilter();
  const offsetStore = new TelegramOffsetStore({ filePath: config.telegramOffsetFile });

  function ensureAccount() {
    if (!selectedAccount) {
      selectedAccount = resolveSelectedTelegramAccount(config);
    }
    return selectedAccount;
  }

  async function sendTextChunks({ userId, text, preserveBlock = false, parseMode = "", contextToken = "" }) {
    const account = ensureAccount();
    const chatId = resolveChatId(userId, contextToken);
    if (!chatId) {
      throw new Error("telegram sendText requires a chatId (userId)");
    }
    const content = String(text || "");
    if (!content.trim()) {
      return;
    }
    const chunks = preserveBlock ? [content] : splitForTelegram(content, MAX_TELEGRAM_TEXT_BYTES);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await sendMessage({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        chatId,
        text: chunk,
        parseMode,
      });
      if (index < chunks.length - 1) {
        await sleep(SEND_MESSAGE_INTERVAL_MS);
      }
    }
  }

  function resolveChatId(userId, contextToken) {
    const tokenStr = String(contextToken || "").trim();
    if (tokenStr.startsWith("tg:")) {
      const fromToken = tokenStr.slice(3).trim();
      if (fromToken) return fromToken;
    }
    const userStr = String(userId || "").trim();
    if (!userStr) return "";
    if (/^-?\d+$/.test(userStr)) return userStr;
    return "";
  }

  return {
    describe() {
      const account = trySelectAccount();
      return {
        id: "telegram",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.telegramApiBaseUrl,
        accountsDir: config.accountsDir,
        botUsername: account?.botUsername || "",
        botId: account?.botId || 0,
        capabilities: {
          channelId: "telegram",
          showThinking: config.telegramShowThinking !== false,
          supportsTyping: true,
          supportsAttachments: true,
          supportsChunkConfig: false,
          supportsHtml: true,
        },
      };
    },
    async login() {
      await runTelegramLoginFlow(config);
    },
    printAccounts() {
      const { listTelegramAccounts } = require("./account-store");
      const accounts = listTelegramAccounts(config);
      if (!accounts.length) {
        console.log("No saved Telegram bot found. Run `cyberboss login --channel telegram` first.");
        return;
      }
      console.log("Saved Telegram bots:");
      for (const account of accounts) {
        console.log(`- ${account.accountId}`);
        console.log(`  botId: ${account.botId || "(unknown)"}`);
        console.log(`  botUsername: @${account.botUsername || "(unknown)"}`);
        console.log(`  apiBaseUrl: ${account.apiBaseUrl}`);
        console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
      }
    },
    resolveAccount() {
      return ensureAccount();
    },
    getKnownContextTokens() {
      return {};
    },
    rememberContextToken() {
      return "";
    },
    loadSyncBuffer() {
      return "";
    },
    saveSyncBuffer() {
      // telegram uses offset store, no-op here
    },
    async getUpdates({ timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_S * 1000 } = {}) {
      const account = ensureAccount();
      const offset = offsetStore.getOffset(account.accountId);
      const timeoutS = Math.max(1, Math.floor(Number(timeoutMs) / 1000) || DEFAULT_LONG_POLL_TIMEOUT_S);
      const updates = await getUpdates({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        offset,
        timeoutS,
        allowedUpdates: ["message", "edited_message"],
      });
      const list = Array.isArray(updates) ? updates : [];
      if (list.length) {
        const maxUpdateId = list.reduce((acc, update) => Math.max(acc, Number(update.update_id) || 0), offset - 1);
        offsetStore.setOffset(account.accountId, maxUpdateId + 1);
        for (const update of list) {
          const msg = update.message || update.edited_message || {};
          const fromId = msg?.from?.id ?? "";
          const chatId = msg?.chat?.id ?? "";
          const preview = String(msg.text || msg.caption || "[media]").slice(0, 60);
          console.log(`[telegram] update_id=${update.update_id} chat=${chatId} from=${fromId} text=${JSON.stringify(preview)}`);
        }
      }
      return { ret: 0, msgs: list, get_updates_buf: "" };
    },
    normalizeIncomingMessage(message) {
      const account = ensureAccount();
      return inboundFilter.normalize(message, config, account, identityMapStore);
    },
    async sendText({ userId, text, contextToken = "", preserveBlock = false }) {
      const inferredParseMode = detectParseMode(text);
      await sendTextChunks({ userId, text, preserveBlock, parseMode: inferredParseMode, contextToken });
    },
    async sendTyping({ userId, status = 1, contextToken = "" }) {
      if (!status) {
        return;
      }
      const account = ensureAccount();
      const chatId = resolveChatId(userId, contextToken);
      if (!chatId) return;
      await sendChatAction({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        chatId,
        action: "typing",
      }).catch(() => {});
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      const account = ensureAccount();
      const chatId = resolveChatId(userId, contextToken);
      if (!chatId) {
        throw new Error("telegram sendFile requires a chatId");
      }
      const buffer = await fs.readFile(filePath);
      const fileName = path.basename(filePath);
      const lower = fileName.toLowerCase();
      if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp")) {
        return sendPhoto({
          baseUrl: account.apiBaseUrl,
          botToken: account.botToken,
          chatId,
          fileBuffer: buffer,
          fileName,
        });
      }
      return sendDocument({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        chatId,
        fileBuffer: buffer,
        fileName,
      });
    },
    setMinChunkChars() {
      return MAX_TELEGRAM_TEXT_BYTES;
    },
    getMinChunkChars() {
      return MAX_TELEGRAM_TEXT_BYTES;
    },
  };

  function trySelectAccount() {
    try {
      return ensureAccount();
    } catch {
      return null;
    }
  }
}

function splitForTelegram(text, maxLength) {
  const normalized = String(text || "");
  if (Buffer.byteLength(normalized, "utf8") <= maxLength) {
    return [normalized];
  }
  const out = [];
  const lines = normalized.split(/\n/);
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate, "utf8") > maxLength) {
      if (current) {
        out.push(current);
        current = "";
      }
      if (Buffer.byteLength(line, "utf8") > maxLength) {
        let remaining = line;
        while (Buffer.byteLength(remaining, "utf8") > maxLength) {
          const slice = sliceUtf8(remaining, maxLength);
          out.push(slice);
          remaining = remaining.slice(slice.length);
        }
        if (remaining) {
          current = remaining;
        }
      } else {
        current = line;
      }
    } else {
      current = candidate;
    }
  }
  if (current) {
    out.push(current);
  }
  return out.filter(Boolean);
}

function sliceUtf8(text, maxBytes) {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += ch.length;
  }
  return text.slice(0, end);
}

function detectParseMode(text) {
  const value = String(text || "");
  if (/<blockquote\b[^>]*>[\s\S]*<\/blockquote>/.test(value)) {
    return "HTML";
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createTelegramChannelAdapter };
