const { resolvePreferredSenderId } = require("../core/default-targets");

class ChannelDeliveryTargetResolver {
  constructor({ config, sessionStore, channels, identityMapStore = null, lastActiveStore = null, defaultChannelId = "" }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.channels = channels instanceof Map ? channels : new Map();
    this.identityMapStore = identityMapStore;
    this.lastActiveStore = lastActiveStore;
    this.defaultChannelId = normalizeText(defaultChannelId)
      || normalizeText(config?.defaultOutboundChannel)
      || "weixin";
  }

  resolve({ context = {}, userId = "", channelId = "" } = {}) {
    const contextTarget = normalizeContextTarget(context);
    const explicitUserId = normalizeText(userId);
    const explicitChannelId = normalizeChannelId(channelId);
    if (explicitChannelId) {
      const requestedUserId = explicitUserId
        || (contextTarget?.channelId === explicitChannelId ? contextTarget.userId : normalizeText(context?.senderId));
      return this.ensureUsableTarget(this.buildTargetForChannel(explicitChannelId, requestedUserId));
    }

    if (contextTarget) {
      return this.ensureUsableTarget(contextTarget);
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
      const chatId = resolveTelegramChatId(requestedUserId)
        || this.resolveBoundExternalId("telegram", requestedUserId);
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

    if (normalizedChannelId === "qq") {
      const qqUserId = resolveQqUserId(requestedUserId)
        || this.resolveBoundExternalId("qq", requestedUserId);
      if (!qqUserId) throw new Error("Cannot determine which QQ user should receive the file.");
      return { channelId: "qq", provider: "qq", userId: qqUserId, contextToken: `qq:${qqUserId}` };
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

  resolveBoundExternalId(channelId, canonicalSenderId) {
    const normalizedSenderId = normalizeText(canonicalSenderId);
    if (!normalizedSenderId || typeof this.identityMapStore?.listBindingsForCanonical !== "function") {
      return "";
    }
    const binding = this.identityMapStore.listBindingsForCanonical(normalizedSenderId)
      .find((entry) => normalizeChannelId(entry?.channel) === channelId);
    const externalId = normalizeText(binding?.externalId);
    if (channelId === "telegram") return resolveTelegramChatId(externalId);
    if (channelId === "qq") return resolveQqUserId(externalId);
    return externalId;
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
    if (channelId === "qq" && !resolveQqUserId(contextToken || userId)) {
      throw new Error("Cannot determine which QQ user should receive the file.");
    }
    if (!["telegram", "qq"].includes(channelId) && !contextToken) {
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

function resolveQqUserId(value) {
  const normalized = normalizeText(value);
  const candidate = normalized.startsWith("qq:") ? normalized.slice(3).trim() : normalized;
  return /^\d+$/.test(candidate) ? candidate : "";
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
  resolveQqUserId,
  resolveTelegramChatId,
};
