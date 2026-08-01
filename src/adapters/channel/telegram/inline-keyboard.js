const INLINE_KEYBOARD_PREFIX = "telegram-inline-keyboard:";
const MAX_BUTTONS = 8;
const MAX_BUTTON_TEXT_CHARS = 64;
const MAX_CALLBACK_DATA_BYTES = 64;

function extractTelegramInlineKeyboard(text) {
  const source = String(text || "");
  const markerIndex = source.lastIndexOf(`<!--${INLINE_KEYBOARD_PREFIX}`);
  if (markerIndex < 0) {
    return { text: source, buttons: [] };
  }

  const suffix = source.slice(markerIndex);
  const match = suffix.match(/^<!--telegram-inline-keyboard:([\s\S]*?)-->\s*$/);
  if (!match) {
    return { text: source, buttons: [] };
  }

  const visibleText = source.slice(0, markerIndex).trimEnd();
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { text: visibleText, buttons: [] };
  }

  return {
    text: visibleText,
    buttons: normalizeInlineKeyboardButtons(parsed),
  };
}

function normalizeInlineKeyboardButtons(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const buttons = [];
  for (const item of value) {
    if (buttons.length >= MAX_BUTTONS) {
      break;
    }
    const text = String(item?.text || "").trim();
    const callbackData = String(item?.callback_data || "").trim();
    if (!text || !callbackData) {
      continue;
    }
    if (Array.from(text).length > MAX_BUTTON_TEXT_CHARS) {
      continue;
    }
    if (Buffer.byteLength(callbackData, "utf8") > MAX_CALLBACK_DATA_BYTES) {
      continue;
    }
    buttons.push({ text, callback_data: callbackData });
  }
  return buttons;
}

function buildTelegramReplyMarkup(buttons) {
  const normalized = normalizeInlineKeyboardButtons(buttons);
  if (!normalized.length) {
    return null;
  }
  return {
    inline_keyboard: normalized.map((button) => [button]),
  };
}

function findCallbackButton(callbackQuery) {
  const callbackData = String(callbackQuery?.data || "");
  const rows = callbackQuery?.message?.reply_markup?.inline_keyboard;
  if (!callbackData || !Array.isArray(rows)) {
    return null;
  }
  for (const row of rows) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (String(button?.callback_data || "") === callbackData) {
        return {
          text: String(button?.text || "").trim(),
          callback_data: callbackData,
        };
      }
    }
  }
  return null;
}

function findCallbackButtonText(callbackQuery) {
  return findCallbackButton(callbackQuery)?.text || "";
}

function buildCallbackInboundUpdate(update, text) {
  const query = update?.callback_query;
  const message = query?.message;
  const normalizedText = String(text || "").trim();
  if (!query || !message || !normalizedText) {
    return null;
  }
  return {
    update_id: update.update_id,
    message: {
      message_id: message.message_id,
      date: Math.floor(Date.now() / 1000),
      from: query.from,
      chat: message.chat,
      text: normalizedText,
    },
  };
}

module.exports = {
  buildCallbackInboundUpdate,
  buildTelegramReplyMarkup,
  extractTelegramInlineKeyboard,
  findCallbackButton,
  findCallbackButtonText,
  normalizeInlineKeyboardButtons,
};
