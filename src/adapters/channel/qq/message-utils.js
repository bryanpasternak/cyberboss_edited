const DEDUP_TTL_MS = 5 * 60_000;

function createQqInboundFilter() {
  const seen = new Map();
  return {
    normalize(event, config, account, identityMap) {
      if (!event || event.post_type !== "message" || event.message_type !== "private") return null;
      const selfId = normalizeId(event.self_id || account?.selfId);
      const externalUserId = normalizeId(event.user_id);
      if (!externalUserId || externalUserId === selfId) return null;

      const allowed = Array.isArray(config?.qqAllowedUserIds)
        ? config.qqAllowedUserIds.map(normalizeId).filter(Boolean)
        : [];
      if (allowed.length && !allowed.includes(externalUserId)) return null;

      const messageId = normalizeId(event.message_id);
      pruneSeen(seen);
      if (messageId && seen.has(messageId)) return null;
      if (messageId) seen.set(messageId, Date.now());

      const text = extractQqText(event.message, event.raw_message);
      const attachments = extractQqAttachments(event.message);
      if (!text && !attachments.length) return null;

      const canonical = identityMap?.resolveCanonical?.({ channel: "qq", externalId: externalUserId }) || null;
      const canonicalSenderId = normalizeId(canonical?.senderId);
      const canonicalAccountId = normalizeId(canonical?.accountId);
      const timestampSeconds = Number(event.time);
      return {
        provider: "qq",
        accountId: canonicalAccountId || account?.accountId || `qq:${selfId}`,
        workspaceId: config.workspaceId,
        senderId: canonicalSenderId || `qq:${externalUserId}`,
        chatId: externalUserId,
        messageId,
        threadKey: `private:${externalUserId}`,
        text,
        attachments,
        contextToken: `qq:${externalUserId}`,
        receivedAt: Number.isFinite(timestampSeconds) && timestampSeconds > 0
          ? new Date(timestampSeconds * 1000).toISOString()
          : new Date().toISOString(),
        externalSenderId: externalUserId,
        canonicalSenderId,
        canonicalAccountId,
        senderProfile: {
          nickname: typeof event?.sender?.nickname === "string" ? event.sender.nickname : "",
          card: typeof event?.sender?.card === "string" ? event.sender.card : "",
        },
      };
    },
  };
}

function extractQqAttachments(message) {
  if (!Array.isArray(message)) return [];
  return message.flatMap((segment, index) => {
    const type = String(segment?.type || "").trim().toLowerCase();
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};
    const kind = {
      image: "image",
      file: "file",
      record: "voice",
      video: "video",
    }[type];
    if (!kind) return [];
    const source = firstNonEmpty(data.url, data.file);
    if (!source && !firstNonEmpty(data.file_id, data.id)) return [];
    return [{
      kind,
      itemType: type,
      fileName: firstNonEmpty(data.name, inferFileName(source, `${type}-${index + 1}`)),
      source,
      url: /^https?:\/\//i.test(source) ? source : "",
      fileId: firstNonEmpty(data.file_id, data.id),
    }];
  });
}

function extractQqText(message, rawMessage = "") {
  if (Array.isArray(message)) {
    return message
      .filter((segment) => segment?.type === "text")
      .map((segment) => String(segment?.data?.text || ""))
      .join("")
      .trim();
  }
  if (typeof message === "string" && message.trim()) return message.trim();
  return typeof rawMessage === "string" ? rawMessage.trim() : "";
}

function pruneSeen(seen) {
  const now = Date.now();
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > DEDUP_TTL_MS) seen.delete(key);
  }
}

function inferFileName(source, fallback) {
  const value = String(source || "").trim();
  if (!value || value.startsWith("base64://")) return fallback;
  try {
    const parsed = new URL(value);
    const name = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    return name || fallback;
  } catch {
    return value.replace(/\\/g, "/").split("/").pop() || fallback;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = value == null ? "" : String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeId(value) {
  if (value == null) return "";
  return String(value).trim();
}

module.exports = { createQqInboundFilter, extractQqAttachments, extractQqText };
