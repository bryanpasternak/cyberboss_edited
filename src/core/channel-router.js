class ChannelRouter {
  constructor({ channels = [], lastActiveStore = null, defaultChannelId = "" } = {}) {
    this.channelsById = new Map();
    for (const channel of Array.isArray(channels) ? channels : []) {
      const id = resolveChannelId(channel);
      if (!id) {
        continue;
      }
      this.channelsById.set(id, channel);
    }
    this.lastActiveStore = lastActiveStore;
    this.defaultChannelId = normalizeText(defaultChannelId)
      || (this.channelsById.size ? this.channelsById.keys().next().value : "");
  }

  getChannel(channelId) {
    const normalized = normalizeText(channelId);
    if (!normalized) {
      return null;
    }
    return this.channelsById.get(normalized) || null;
  }

  listChannels() {
    return [...this.channelsById.values()];
  }

  listChannelIds() {
    return [...this.channelsById.keys()];
  }

  hasChannel(channelId) {
    const normalized = normalizeText(channelId);
    return Boolean(normalized) && this.channelsById.has(normalized);
  }

  describeAll() {
    return [...this.channelsById.values()].map((channel) => {
      try {
        return channel.describe();
      } catch {
        return { id: resolveChannelId(channel) };
      }
    });
  }

  pickChannelForSender(senderId) {
    const lastActive = this.lastActiveStore && typeof this.lastActiveStore.resolve === "function"
      ? this.lastActiveStore.resolve(senderId)
      : null;
    const lastChannelId = normalizeText(lastActive?.channelId);
    if (lastChannelId && this.channelsById.has(lastChannelId)) {
      return this.channelsById.get(lastChannelId);
    }
    if (this.defaultChannelId && this.channelsById.has(this.defaultChannelId)) {
      return this.channelsById.get(this.defaultChannelId);
    }
    return this.channelsById.size ? this.channelsById.values().next().value : null;
  }

  pickChannelIdForSender(senderId) {
    const channel = this.pickChannelForSender(senderId);
    return channel ? resolveChannelId(channel) : "";
  }

  capabilitiesForChannel(channelId) {
    const channel = this.getChannel(channelId);
    if (!channel) {
      return null;
    }
    try {
      return channel.describe().capabilities || null;
    } catch {
      return null;
    }
  }

  markActive(senderId, channelId) {
    if (!this.lastActiveStore || typeof this.lastActiveStore.mark !== "function") {
      return;
    }
    this.lastActiveStore.mark(senderId, channelId);
  }
}

function resolveChannelId(channel) {
  if (!channel || typeof channel !== "object") {
    return "";
  }
  if (typeof channel.describe === "function") {
    try {
      const description = channel.describe();
      const fromCapabilities = normalizeText(description?.capabilities?.channelId);
      if (fromCapabilities) {
        return fromCapabilities;
      }
      const fromId = normalizeText(description?.id);
      if (fromId) {
        return fromId;
      }
    } catch {
      // ignore — fall through
    }
  }
  return normalizeText(channel.id);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChannelRouter };
