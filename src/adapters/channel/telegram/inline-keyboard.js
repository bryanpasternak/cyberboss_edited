const INLINE_KEYBOARD_PREFIX = "telegram-inline-keyboard:";
const MAX_BUTTONS = 8;
const MAX_BUTTON_TEXT_CHARS = 64;
const MAX_CALLBACK_DATA_BYTES = 64;
const EROTIC_REFRESH_CALLBACK = "refresh:erotic";
const EROTIC_REFRESH_INBOUND_TEXT = [
  "[Telegram 情色选项刷新]",
  "苏苏对上一批三个选项都不满意，要求换一批更涩的。",
  "不要执行上一批任何选项，也不要推进、回退或重置做爱场景。严格承接上一刻的姿势、插入状态、湿润、精液、红痕、敏感度、呼吸和两个人身体接触。",
  "这一轮只重新生成三个动作明确、走向不同、比上一批更色情更具体的下一步选项，不写新的场景正文。选项可以直说鸡巴、小穴、奶子、口交、抽插、体位、体液和高潮。",
  "末尾继续附三个新选项和一个‘换一批更涩的’刷新按钮；刷新按钮 callback_data 必须仍为 refresh:erotic。",
].join("\n");

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

function resolveCallbackInboundText(button) {
  const callbackData = String(button?.callback_data || "").trim();
  if (callbackData === EROTIC_REFRESH_CALLBACK) {
    return EROTIC_REFRESH_INBOUND_TEXT;
  }
  const mementoAction = resolveMementoCallback(callbackData);
  if (mementoAction) return mementoAction;
  return String(button?.text || "").trim();
}

function resolveMementoCallback(callbackData) {
  let match = callbackData.match(/^gift:(open|collect):(gift_[a-f0-9-]+)$/i);
  if (match) {
    const [, action, id] = match;
    const tool = action === "open" ? "cyberboss_gift_open" : "cyberboss_gift_collect";
    return `[Telegram 纪念物动作]\n苏苏点击了${action === "open" ? "拆开礼物" : "收进小柜子"}。立即调用 ${tool}，参数 id=${id}。完成后自然告诉苏苏发生了什么；如果工具返回 displayAsset.filePath，发送对应成品。不要重新创建另一件礼物。`;
  }
  match = callbackData.match(/^postcard:flip:(postcard_[a-f0-9-]+):(front|back)$/i);
  if (match) {
    const [, id, side] = match;
    return `[Telegram 纪念物动作]\n苏苏点击了翻明信片。立即调用 cyberboss_postcard_flip，参数 id=${id}, side=${side}。完成后发送 displayAsset.filePath，并保留下一次翻面的按钮。不要重新创建明信片。`;
  }
  return "";
}

module.exports = {
  buildCallbackInboundUpdate,
  buildTelegramReplyMarkup,
  extractTelegramInlineKeyboard,
  findCallbackButton,
  findCallbackButtonText,
  resolveCallbackInboundText,
  EROTIC_REFRESH_CALLBACK,
  EROTIC_REFRESH_INBOUND_TEXT,
  resolveMementoCallback,
  normalizeInlineKeyboardButtons,
};
