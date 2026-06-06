const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_S = 30;
const MAX_RESPONSE_BODY_BYTES = 64 << 20;

let cachedUndici = "__init__";
let cachedProxyAgent = null;
let cachedProxyUrl = "__init__";

function loadUndici() {
  if (cachedUndici !== "__init__") {
    return cachedUndici;
  }
  try {
    cachedUndici = require("undici");
  } catch {
    cachedUndici = null;
  }
  return cachedUndici;
}

function resolveProxyAgent() {
  const proxyUrl = (process.env.CYBERBOSS_TELEGRAM_PROXY
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || "").trim();
  if (proxyUrl === cachedProxyUrl) {
    return cachedProxyAgent;
  }
  cachedProxyUrl = proxyUrl;
  if (!proxyUrl) {
    cachedProxyAgent = null;
    return null;
  }
  const undici = loadUndici();
  if (!undici?.ProxyAgent) {
    console.warn(`[telegram] proxy requested but undici is not installed. Run: npm install undici`);
    cachedProxyAgent = null;
    return null;
  }
  try {
    cachedProxyAgent = new undici.ProxyAgent(proxyUrl);
  } catch (error) {
    console.warn(`[telegram] failed to build proxy agent for ${proxyUrl}: ${error.message}`);
    cachedProxyAgent = null;
  }
  return cachedProxyAgent;
}

function fetchWithProxy(url, init = {}) {
  const agent = resolveProxyAgent();
  if (agent) {
    const undici = loadUndici();
    if (undici?.fetch) {
      return undici.fetch(url, { ...init, dispatcher: agent });
    }
    return fetch(url, { ...init, dispatcher: agent });
  }
  return fetch(url, init);
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "https://api.telegram.org").trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildEndpoint(baseUrl, botToken, method) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const trimmedToken = String(botToken || "").trim();
  if (!trimmedToken) {
    throw new Error("telegram bot token is empty");
  }
  return `${normalizedBase}/bot${trimmedToken}/${method}`;
}

async function request({
  baseUrl,
  botToken,
  method,
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = "telegram",
}) {
  const url = buildEndpoint(baseUrl, botToken, method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 5_000);
  try {
    const response = await fetchWithProxy(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body == null ? "{}" : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`${label} ${method} response too large`);
    }
    if (!response.ok) {
      throw new Error(`${label} ${method} http ${response.status}: ${truncate(raw, 256)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${label} ${method} returned invalid JSON: ${truncate(raw, 256)}`);
    }
    if (!parsed || parsed.ok !== true) {
      const description = (parsed && typeof parsed.description === "string") ? parsed.description : "";
      throw new Error(`${label} ${method} api error: ${description || truncate(raw, 256)}`);
    }
    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text, max) {
  const value = typeof text === "string" ? text : String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

async function getMe({ baseUrl, botToken, timeoutMs }) {
  return request({ baseUrl, botToken, method: "getMe", timeoutMs, label: "telegram" });
}

async function getUpdates({ baseUrl, botToken, offset = 0, timeoutS = DEFAULT_LONG_POLL_TIMEOUT_S, allowedUpdates = null }) {
  const body = {
    timeout: timeoutS,
    offset: Number(offset) || 0,
  };
  if (Array.isArray(allowedUpdates) && allowedUpdates.length) {
    body.allowed_updates = allowedUpdates;
  }
  return request({
    baseUrl,
    botToken,
    method: "getUpdates",
    body,
    timeoutMs: (Number(timeoutS) + 10) * 1000,
    label: "telegram",
  });
}

async function sendMessage({ baseUrl, botToken, chatId, text, parseMode = "", disablePreview = true, replyToMessageId = 0 }) {
  const body = {
    chat_id: chatId,
    text,
  };
  if (parseMode) {
    body.parse_mode = parseMode;
  }
  if (disablePreview) {
    body.link_preview_options = { is_disabled: true };
  }
  if (replyToMessageId) {
    body.reply_parameters = { message_id: Number(replyToMessageId) };
  }
  return request({ baseUrl, botToken, method: "sendMessage", body, label: "telegram" });
}

async function sendChatAction({ baseUrl, botToken, chatId, action = "typing" }) {
  return request({
    baseUrl,
    botToken,
    method: "sendChatAction",
    body: { chat_id: chatId, action },
    label: "telegram",
    timeoutMs: 10_000,
  });
}

async function getFile({ baseUrl, botToken, fileId }) {
  return request({
    baseUrl,
    botToken,
    method: "getFile",
    body: { file_id: fileId },
    label: "telegram",
  });
}

function buildFileDownloadUrl({ baseUrl, botToken, filePath }) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const trimmedToken = String(botToken || "").trim();
  if (!trimmedToken || !filePath) {
    return "";
  }
  return `${normalizedBase}/file/bot${trimmedToken}/${filePath}`;
}

async function sendDocument({ baseUrl, botToken, chatId, fileBuffer, fileName, caption = "" }) {
  return uploadFile({
    baseUrl,
    botToken,
    method: "sendDocument",
    chatId,
    fileBuffer,
    fileName,
    caption,
    fileField: "document",
  });
}

async function sendPhoto({ baseUrl, botToken, chatId, fileBuffer, fileName, caption = "" }) {
  return uploadFile({
    baseUrl,
    botToken,
    method: "sendPhoto",
    chatId,
    fileBuffer,
    fileName,
    caption,
    fileField: "photo",
  });
}

async function uploadFile({ baseUrl, botToken, method, chatId, fileBuffer, fileName, caption, fileField }) {
  const url = buildEndpoint(baseUrl, botToken, method);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", String(caption));
  }
  const blob = new Blob([fileBuffer]);
  form.append(fileField, blob, fileName || `attachment-${Date.now()}`);
  const response = await fetchWithProxy(url, { method: "POST", body: form });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`telegram ${method} http ${response.status}: ${truncate(raw, 256)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`telegram ${method} returned invalid JSON`);
  }
  if (!parsed || parsed.ok !== true) {
    throw new Error(`telegram ${method} api error: ${(parsed && parsed.description) || truncate(raw, 256)}`);
  }
  return parsed.result;
}

module.exports = {
  buildFileDownloadUrl,
  fetchWithProxy,
  getFile,
  getMe,
  getUpdates,
  sendChatAction,
  sendDocument,
  sendMessage,
  sendPhoto,
};
