const TEXT_ITEM_TYPE = 1;
const IMAGE_ITEM_TYPE = 2;
const VOICE_ITEM_TYPE = 3;
const FILE_ITEM_TYPE = 4;
const VIDEO_ITEM_TYPE = 5;
const BOT_MESSAGE_TYPE = 2;

function normalizeWeixinIncomingMessage(message, config, accountId) {
  if (!message || typeof message !== "object") {
    return null;
  }
  if (Number(message.message_type) === BOT_MESSAGE_TYPE) {
    return null;
  }

  const senderId = normalizeText(message.from_user_id);
  if (!senderId) {
    return null;
  }

  const text = extractTextBody(message.item_list);
  const attachments = extractAttachmentItems(message.item_list);
  if (!text && !attachments.length) {
    return null;
  }

  return {
    provider: "weixin",
    accountId,
    workspaceId: config.workspaceId,
    senderId,
    chatId: senderId,
    messageId: normalizeText(message.message_id),
    threadKey: normalizeText(message.session_id),
    text,
    attachments,
    contextToken: normalizeText(message.context_token),
    receivedAt: resolveReceivedAt(message),
  };
}

function extractTextBody(itemList) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return "";
  }

  for (const item of itemList) {
    if (Number(item?.type) === TEXT_ITEM_TYPE && typeof item?.text_item?.text === "string") {
      return item.text_item.text.trim();
    }
    if (Number(item?.type) === VOICE_ITEM_TYPE && typeof item?.voice_item?.text === "string") {
      return item.voice_item.text.trim();
    }
  }

  return "";
}

function extractAttachmentItems(itemList) {
  if (!Array.isArray(itemList) || !itemList.length) {
    return [];
  }

  const attachments = [];
  for (let index = 0; index < itemList.length; index += 1) {
    const normalized = normalizeAttachmentItem(itemList[index], index);
    if (normalized) {
      attachments.push(normalized);
    }
  }

  return attachments;
}

function normalizeAttachmentItem(item, index) {
  const itemType = Number(item?.type);
  const payload = resolveAttachmentPayload(itemType, item);
  if (!payload) {
    return null;
  }

  const media = payload.media && typeof payload.media === "object"
    ? payload.media
    : {};

  return {
    kind: payload.kind,
    itemType,
    index,
    fileName: normalizeText(
      payload.body?.file_name
      || payload.body?.filename
      || item?.file_name
      || item?.filename
    ),
    sizeBytes: parseOptionalInt(
      payload.body?.len
      || payload.body?.file_size
      || payload.body?.size
      || payload.body?.video_size
      || item?.len
    ),
    directUrls: collectStringValues([
      payload.body?.url,
      payload.body?.download_url,
      payload.body?.cdn_url,
      media?.url,
      media?.download_url,
      media?.cdn_url,
    ]),
    mediaRef: {
      encryptQueryParam: normalizeText(
        media?.encrypt_query_param
        || media?.encrypted_query_param
        || payload.body?.encrypt_query_param
        || payload.body?.encrypted_query_param
        || item?.encrypt_query_param
        || item?.encrypted_query_param
      ),
      aesKey: normalizeText(
        media?.aes_key
        || payload.body?.aes_key
        || item?.aes_key
      ),
      aesKeyHex: normalizeText(
        payload.body?.aeskey
        || payload.body?.aes_key_hex
        || item?.aeskey
      ),
      encryptType: Number(
        media?.encrypt_type
        ?? payload.body?.encrypt_type
        ?? item?.encrypt_type
        ?? 1
      ),
      fileKey: normalizeText(
        media?.filekey
        || payload.body?.filekey
        || item?.filekey
      ),
    },
    rawItem: item,
  };
}

function resolveAttachmentPayload(itemType, item) {
  if (itemType === IMAGE_ITEM_TYPE && item?.image_item && typeof item.image_item === "object") {
    return { kind: "image", body: item.image_item, media: item.image_item.media };
  }
  if (itemType === FILE_ITEM_TYPE && item?.file_item && typeof item.file_item === "object") {
    return { kind: "file", body: item.file_item, media: item.file_item.media };
  }
  if (itemType === VIDEO_ITEM_TYPE && item?.video_item && typeof item.video_item === "object") {
    return { kind: "video", body: item.video_item, media: item.video_item.media };
  }
  return null;
}

function collectStringValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseOptionalInt(value) {
  if (value == null || value === "") {
    return 0;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveReceivedAt(message) {
  const rawMs = Number(message?.create_time_ms);
  if (Number.isFinite(rawMs) && rawMs > 0) {
    return new Date(rawMs).toISOString();
  }
  const rawSeconds = Number(message?.create_time);
  if (Number.isFinite(rawSeconds) && rawSeconds > 0) {
    return new Date(rawSeconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

module.exports = {
  normalizeWeixinIncomingMessage,
};
