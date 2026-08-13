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
      if (!text) return null;

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
        attachments: [],
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

function normalizeId(value) {
  if (value == null) return "";
  return String(value).trim();
}

module.exports = { createQqInboundFilter, extractQqText };
