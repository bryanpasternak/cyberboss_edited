const DEDUP_TTL_MS = 5 * 60_000;

function createInboundFilter() {
  const seen = new Map();

  return {
    normalize(update, config, account, identityMap) {
      if (!update || typeof update !== "object") {
        return null;
      }
      const message = update.message || update.edited_message || null;
      if (!message || typeof message !== "object") {
        return null;
      }
      const fromUser = message.from || {};
      if (fromUser.is_bot === true) {
        return null;
      }
      const chat = message.chat || {};
      const chatId = String(chat.id != null ? chat.id : "").trim();
      const externalUserId = String(fromUser.id != null ? fromUser.id : "").trim();
      if (!chatId || !externalUserId) {
        return null;
      }

      const dedupKey = buildDedupKey(message, chatId);
      pruneSeen(seen);
      if (dedupKey && seen.has(dedupKey)) {
        return null;
      }
      if (dedupKey) {
        seen.set(dedupKey, Date.now());
      }

      const allowedChatIds = Array.isArray(config?.telegramAllowedChatIds) ? config.telegramAllowedChatIds : [];
      const isAllowedChat = !allowedChatIds.length
        || allowedChatIds.includes(chatId)
        || allowedChatIds.includes(externalUserId);

      const text = extractInboundText(message);
      const attachments = extractAttachmentItems(message);
      if (!text && !attachments.length) {
        return null;
      }

      const canonical = identityMap && typeof identityMap.resolveCanonical === "function"
        ? identityMap.resolveCanonical({ channel: "telegram", externalId: externalUserId })
        : (identityMap && typeof identityMap.resolveCanonicalSenderId === "function"
            ? { senderId: identityMap.resolveCanonicalSenderId({ channel: "telegram", externalId: externalUserId }), accountId: "" }
            : null);
      const canonicalSenderId = canonical?.senderId || "";
      const canonicalAccountId = canonical?.accountId || "";

      const createdAtMs = Number(message.date) > 0 ? Number(message.date) * 1000 : Date.now();
      return {
        provider: "telegram",
        accountId: canonicalAccountId || account?.accountId || "telegram",
        workspaceId: config.workspaceId,
        senderId: canonicalSenderId || `telegram:${externalUserId}`,
        chatId,
        messageId: String(message.message_id || ""),
        threadKey: chatId,
        text,
        attachments,
        contextToken: `tg:${chatId}`,
        receivedAt: new Date(createdAtMs).toISOString(),
        externalSenderId: externalUserId,
        canonicalSenderId,
        canonicalAccountId,
        isAllowedChat,
        senderProfile: {
          firstName: typeof fromUser.first_name === "string" ? fromUser.first_name : "",
          lastName: typeof fromUser.last_name === "string" ? fromUser.last_name : "",
          username: typeof fromUser.username === "string" ? fromUser.username : "",
          languageCode: typeof fromUser.language_code === "string" ? fromUser.language_code : "",
        },
      };
    },
  };
}

function extractInboundText(message) {
  const text = typeof message.text === "string" ? message.text : "";
  if (text.trim()) {
    return text;
  }
  const caption = typeof message.caption === "string" ? message.caption : "";
  if (caption.trim()) {
    return caption;
  }
  if (message.voice || message.audio) {
    return "[voice message]";
  }
  return "";
}

function extractAttachmentItems(message) {
  const out = [];
  let index = 0;

  if (Array.isArray(message.photo) && message.photo.length) {
    const photoSizes = message.photo.slice().sort((a, b) => Number(b.file_size || 0) - Number(a.file_size || 0));
    const largest = photoSizes[0];
    if (largest?.file_id) {
      out.push({
        kind: "image",
        itemType: "photo",
        index: index++,
        fileId: String(largest.file_id),
        fileName: `tg-photo-${message.message_id || Date.now()}.jpg`,
        sizeBytes: Number(largest.file_size) || 0,
        directUrls: [],
        mediaRef: {},
        rawItem: largest,
      });
    }
  }

  if (message.document?.file_id) {
    const doc = message.document;
    out.push({
      kind: detectKindFromMime(doc.mime_type) || "file",
      itemType: "document",
      index: index++,
      fileId: String(doc.file_id),
      fileName: typeof doc.file_name === "string" && doc.file_name.trim()
        ? doc.file_name.trim()
        : `tg-document-${message.message_id || Date.now()}`,
      sizeBytes: Number(doc.file_size) || 0,
      directUrls: [],
      mediaRef: { mimeType: doc.mime_type || "" },
      rawItem: doc,
    });
  }

  if (message.video?.file_id) {
    const video = message.video;
    out.push({
      kind: "video",
      itemType: "video",
      index: index++,
      fileId: String(video.file_id),
      fileName: `tg-video-${message.message_id || Date.now()}.mp4`,
      sizeBytes: Number(video.file_size) || 0,
      directUrls: [],
      mediaRef: { mimeType: video.mime_type || "" },
      rawItem: video,
    });
  }

  if (message.voice?.file_id) {
    const voice = message.voice;
    out.push({
      kind: "voice",
      itemType: "voice",
      index: index++,
      fileId: String(voice.file_id),
      fileName: `tg-voice-${message.message_id || Date.now()}.ogg`,
      sizeBytes: Number(voice.file_size) || 0,
      directUrls: [],
      mediaRef: { mimeType: voice.mime_type || "" },
      rawItem: voice,
    });
  }

  if (message.audio?.file_id) {
    const audio = message.audio;
    out.push({
      kind: "audio",
      itemType: "audio",
      index: index++,
      fileId: String(audio.file_id),
      fileName: typeof audio.file_name === "string" && audio.file_name.trim()
        ? audio.file_name.trim()
        : `tg-audio-${message.message_id || Date.now()}.mp3`,
      sizeBytes: Number(audio.file_size) || 0,
      directUrls: [],
      mediaRef: { mimeType: audio.mime_type || "", duration: Number(audio.duration) || 0 },
      rawItem: audio,
    });
  }

  if (message.animation?.file_id) {
    const animation = message.animation;
    out.push({
      kind: "animation",
      itemType: "animation",
      index: index++,
      fileId: String(animation.file_id),
      fileName: typeof animation.file_name === "string" && animation.file_name.trim()
        ? animation.file_name.trim()
        : `tg-animation-${message.message_id || Date.now()}.gif`,
      sizeBytes: Number(animation.file_size) || 0,
      directUrls: [],
      mediaRef: { mimeType: animation.mime_type || "" },
      rawItem: animation,
    });
  }

  if (message.video_note?.file_id) {
    const videoNote = message.video_note;
    out.push({
      kind: "video",
      itemType: "video_note",
      index: index++,
      fileId: String(videoNote.file_id),
      fileName: `tg-video-note-${message.message_id || Date.now()}.mp4`,
      sizeBytes: Number(videoNote.file_size) || 0,
      directUrls: [],
      mediaRef: { duration: Number(videoNote.duration) || 0 },
      rawItem: videoNote,
    });
  }

  if (message.sticker?.file_id) {
    const sticker = message.sticker;
    out.push({
      kind: "image",
      itemType: "sticker",
      index: index++,
      fileId: String(sticker.file_id),
      fileName: `tg-sticker-${message.message_id || Date.now()}.webp`,
      sizeBytes: Number(sticker.file_size) || 0,
      directUrls: [],
      mediaRef: { isAnimated: !!sticker.is_animated, isVideo: !!sticker.is_video },
      rawItem: sticker,
    });
  }

  return out;
}

function detectKindFromMime(mimeType) {
  const value = String(mimeType || "").toLowerCase();
  if (!value) return "";
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  return "file";
}

function buildDedupKey(message, chatId) {
  const messageId = String(message?.message_id || "");
  const editDate = String(message?.edit_date || "");
  return `${chatId}|${messageId}|${editDate}`;
}

function pruneSeen(seen) {
  const now = Date.now();
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) {
      seen.delete(key);
    }
  }
}

module.exports = { createInboundFilter, extractAttachmentItems };
