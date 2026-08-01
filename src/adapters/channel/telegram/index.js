const fs = require("fs/promises");
const path = require("path");
const { resolveSelectedTelegramAccount } = require("./account-store");
const { runTelegramLoginFlow } = require("./login");
const { createInboundFilter } = require("./message-utils");
const { TelegramOffsetStore } = require("./offset-store");
const {
  buildCallbackInboundUpdate,
  buildTelegramReplyMarkup,
  extractTelegramInlineKeyboard,
  findCallbackButton,
  findCallbackButtonText,
} = require("./inline-keyboard");
const {
  collectStreamingBoundaries,
  splitTextAtBoundaries,
  trimOuterBlankLines,
} = require("../weixin");
const {
  DEFAULT_MIN_TELEGRAM_CHUNK,
  MAX_MIN_TELEGRAM_CHUNK,
  loadTelegramConfig,
  saveTelegramConfig,
} = require("./config-store");
const {
  answerCallbackQuery,
  editMessageReplyMarkup,
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
  let minTelegramChunk = loadTelegramConfig(config).minChunkChars;

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
    const extracted = extractTelegramInlineKeyboard(text);
    const content = extracted.text;
    const replyMarkup = buildTelegramReplyMarkup(extracted.buttons);
    if (!content.trim() && !replyMarkup) {
      return;
    }
    const visibleContent = content.trim() || "请选择：";
    const chunks = preserveBlock
      ? splitForTelegram(visibleContent, MAX_TELEGRAM_TEXT_BYTES)
      : chunkReplyTextForTelegram(visibleContent, minTelegramChunk);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      await sendMessage({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        chatId,
        text: chunk,
        parseMode,
        replyMarkup: index === chunks.length - 1 ? replyMarkup : null,
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
          supportsChunkConfig: true,
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
        allowedUpdates: ["message", "edited_message", "callback_query"],
      });
      const rawList = Array.isArray(updates) ? updates : [];
      const list = [];
      for (const update of rawList) {
        if (!update?.callback_query) {
          list.push(update);
          continue;
        }
        const callbackUpdate = await handleCallbackQueryUpdate(update, account);
        if (callbackUpdate) {
          list.push(callbackUpdate);
        }
      }
      if (rawList.length) {
        const maxUpdateId = rawList.reduce((acc, update) => Math.max(acc, Number(update.update_id) || 0), offset - 1);
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
    setMinChunkChars(value) {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_TELEGRAM_CHUNK) {
        minTelegramChunk = parsed;
        saveTelegramConfig(config, { minChunkChars: minTelegramChunk });
      }
      return minTelegramChunk;
    },
    getMinChunkChars() {
      return minTelegramChunk;
    },
    getMaxChunkChars() {
      return MAX_MIN_TELEGRAM_CHUNK;
    },
  };

  function trySelectAccount() {
    try {
      return ensureAccount();
    } catch {
      return null;
    }
  }

  async function handleCallbackQueryUpdate(update, account) {
    const query = update?.callback_query;
    const callbackQueryId = String(query?.id || "");
    const chatId = String(query?.message?.chat?.id ?? "");
    const messageId = query?.message?.message_id;
    const externalUserId = String(query?.from?.id ?? "");
    if (!callbackQueryId) {
      return null;
    }

    const selectedButton = findCallbackButton(query);
    const buttonText = selectedButton?.text || "";
    const callbackData = selectedButton?.callback_data || "";
    const allowedChatIds = Array.isArray(config.telegramAllowedChatIds)
      ? config.telegramAllowedChatIds.map(String)
      : [];
    const canonical = identityMapStore && typeof identityMapStore.resolveCanonical === "function"
      ? identityMapStore.resolveCanonical({ channel: "telegram", externalId: externalUserId })
      : null;
    const allowedByConfig = !allowedChatIds.length
      || allowedChatIds.includes(chatId)
      || allowedChatIds.includes(externalUserId)
      || allowedChatIds.includes(String(canonical?.senderId || ""));
    const linkedIdentityRequired = !!identityMapStore;
    const authorized = allowedByConfig && (!linkedIdentityRequired || !!canonical?.senderId);

    await answerCallbackQuery({
      baseUrl: account.apiBaseUrl,
      botToken: account.botToken,
      callbackQueryId,
      text: authorized && buttonText ? "" : "这个选项不能使用或已经失效",
    }).catch(() => {});

    if (!authorized || !buttonText || !chatId || !messageId) {
      return null;
    }

    await editMessageReplyMarkup({
      baseUrl: account.apiBaseUrl,
      botToken: account.botToken,
      chatId,
      messageId,
    }).catch((error) => {
      console.warn(`[telegram] failed to clear inline keyboard chat=${chatId} message=${messageId}: ${error.message}`);
    });

    if (callbackData.startsWith("input:")) {
      const requestedPlaceholder = callbackData.slice("input:".length).trim();
      const inputPlaceholder = Array.from(requestedPlaceholder || "直接输入你的选择").slice(0, 64).join("");
      await sendMessage({
        baseUrl: account.apiBaseUrl,
        botToken: account.botToken,
        chatId,
        text: "好，直接输入你的选择：",
        replyMarkup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: inputPlaceholder,
        },
      });
      return null;
    }

    return buildCallbackInboundUpdate(update, buttonText);
  }
}

function normalizeTelegramReplyText(text) {
  return trimOuterBlankLines(String(text || "").replace(/\r\n/g, "\n"));
}

function chunkReplyTextForTelegram(text, minChunk = DEFAULT_MIN_TELEGRAM_CHUNK) {
  const normalized = normalizeTelegramReplyText(text);
  if (!normalized.trim()) {
    return [];
  }

  const boundaries = collectStreamingBoundaries(normalized);
  const naturalUnits = boundaries.length
    ? splitTextAtBoundaries(normalized, boundaries)
    : [normalized];
  const safeUnits = [];
  for (const unit of naturalUnits.length ? naturalUnits : [normalized]) {
    if (Buffer.byteLength(unit, "utf8") <= MAX_TELEGRAM_TEXT_BYTES) {
      safeUnits.push(unit);
      continue;
    }
    safeUnits.push(...splitForTelegram(unit, MAX_TELEGRAM_TEXT_BYTES));
  }
  return mergeTelegramShortChunks(
    safeUnits.filter((chunk) => String(chunk || "").trim()),
    MAX_TELEGRAM_TEXT_BYTES,
    minChunk,
  );
}

function mergeTelegramShortChunks(chunks, maxBytes, minLength) {
  const normalizedChunks = Array.isArray(chunks)
    ? chunks.map((chunk) => String(chunk || "")).filter((chunk) => chunk.trim())
    : [];
  if (!normalizedChunks.length) {
    return [];
  }

  const merged = [];
  let buffer = normalizedChunks[0];
  for (let index = 1; index < normalizedChunks.length; index += 1) {
    const chunk = normalizedChunks[index];
    const joined = `${buffer}${chunk}`;
    const isShort = buffer.length < minLength && chunk.length < minLength;
    if (isShort && Buffer.byteLength(joined, "utf8") <= maxBytes) {
      buffer = joined;
      continue;
    }
    merged.push(buffer);
    buffer = chunk;
  }
  if (buffer) {
    merged.push(buffer);
  }

  return merged.flatMap((chunk) => splitForTelegram(chunk, maxBytes)).filter(Boolean);
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

module.exports = {
  buildCallbackInboundUpdate,
  buildTelegramReplyMarkup,
  createTelegramChannelAdapter,
  extractTelegramInlineKeyboard,
  findCallbackButton,
  findCallbackButtonText,
  normalizeTelegramReplyText,
  chunkReplyTextForTelegram,
  mergeTelegramShortChunks,
  splitForTelegram,
  sliceUtf8,
};
