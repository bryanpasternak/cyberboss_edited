const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelDeliveryTargetResolver {
  constructor({ config, sessionStore, channels, lastActiveStore = null, defaultChannelId = "" }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.channels = channels instanceof Map ? channels : new Map();
    this.lastActiveStore = lastActiveStore;
    this.defaultChannelId = normalizeText(defaultChannelId)
      || normalizeText(config?.defaultOutboundChannel)
      || "weixin";
  }

  resolve({ context = {}, userId = "", channelId = "" } = {}) {
    const contextTarget = normalizeContextTarget(context);
    if (contextTarget) {
      return this.ensureUsableTarget(contextTarget);
    }

    const explicitUserId = normalizeText(userId);
    const explicitChannelId = normalizeChannelId(channelId);
    if (explicitChannelId) {
      return this.ensureUsableTarget(this.buildTargetForChannel(explicitChannelId, explicitUserId));
    }

    const canonicalSenderId = explicitUserId || normalizeText(context?.senderId);
    const lastActiveChannelId = canonicalSenderId
      ? normalizeChannelId(this.lastActiveStore?.resolve?.(canonicalSenderId)?.channelId)
      : "";
    if (lastActiveChannelId) {
      return this.ensureUsableTarget(this.buildTargetForChannel(lastActiveChannelId, canonicalSenderId));
    }

    return this.ensureUsableTarget(this.buildTargetForChannel(this.defaultChannelId, canonicalSenderId));
  }

  buildTargetForChannel(channelId, requestedUserId) {
    const normalizedChannelId = normalizeChannelId(channelId);
    const channel = this.channels.get(normalizedChannelId);
    if (!channel) {
      throw new Error(`Channel is not enabled: ${normalizedChannelId || "(missing)"}`);
    }

    if (normalizedChannelId === "telegram") {
      const chatId = resolveTelegramChatId(requestedUserId);
      if (!chatId) {
        throw new Error("Cannot determine which Telegram chat should receive the file.");
      }
      return {
        channelId: "telegram",
        provider: "telegram",
        userId: chatId,
        contextToken: `tg:${chatId}`,
      };
    }

    const account = channel.resolveAccount?.();
    const targetUserId = normalizeText(requestedUserId) || resolvePreferredSenderId({
      config: this.config,
      accountId: normalizeText(account?.accountId),
      sessionStore: this.sessionStore,
    });
    if (!targetUserId) {
      throw new Error(`Cannot determine which ${normalizedChannelId} user should receive the file.`);
    }
    const contextToken = normalizeText(channel.getKnownContextTokens?.()[targetUserId]);
    if (!contextToken) {
      throw new Error(`Cannot find a reply context for ${normalizedChannelId} user ${targetUserId}.`);
    }
    return {
      channelId: normalizedChannelId,
      provider: normalizedChannelId,
      userId: targetUserId,
      contextToken,
    };
  }

  ensureUsableTarget(target) {
    const channelId = normalizeChannelId(target?.channelId || target?.provider);
    if (!channelId || !this.channels.has(channelId)) {
      throw new Error(`Channel is not enabled: ${channelId || "(missing)"}`);
    }
    const userId = normalizeText(target?.userId);
    const contextToken = normalizeText(target?.contextToken);
    if (!userId) {
      throw new Error(`Cannot determine the recipient for channel ${channelId}.`);
    }
    if (channelId === "telegram" && !resolveTelegramChatId(contextToken || userId)) {
      throw new Error("Cannot determine which Telegram chat should receive the file.");
    }
    if (channelId !== "telegram" && !contextToken) {
      throw new Error(`Cannot find a reply context for ${channelId} user ${userId}.`);
    }
    return { channelId, provider: channelId, userId, contextToken };
  }
}

function normalizeContextTarget(context) {
  const channelId = normalizeChannelId(context?.channelId || context?.provider);
  const userId = normalizeText(context?.externalUserId || context?.userId || context?.senderId);
  const contextToken = normalizeText(context?.contextToken);
  if (!channelId || channelId === "system" || !userId) {
    return null;
  }
  return { channelId, provider: channelId, userId, contextToken };
}

function resolveTelegramChatId(value) {
  const normalized = normalizeText(value);
  const candidate = normalized.startsWith("tg:") ? normalized.slice(3).trim() : normalized;
  return /^-?\d+$/.test(candidate) ? candidate : "";
}

function normalizeChannelId(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === "wechat" ? "weixin" : normalized;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ChannelDeliveryTargetResolver,
  normalizeContextTarget,
  resolveTelegramChatId,
};
