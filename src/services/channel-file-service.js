const fs = require("fs");
const path = require("path");

class ChannelFileService {
  constructor({ resolveTarget, resolveChannel }) {
    this.resolveTarget = resolveTarget;
    this.resolveChannel = resolveChannel;
  }

  async sendToCurrentChat({
    filePath = "",
    userId = "",
    channelId = "",
    kind = "auto",
    caption = "",
    fileName = "",
  } = {}, context = {}) {
    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }

    const target = this.resolveTarget({ context, userId, channelId });
    const channel = this.resolveChannel(target.channelId);
    if (!channel || (typeof channel.sendMedia !== "function" && typeof channel.sendFile !== "function")) {
      throw new Error(`Channel does not support file delivery: ${target.channelId}`);
    }

    await channel.sendTyping({
      userId: target.userId,
      status: 1,
      contextToken: target.contextToken,
    }).catch(() => {});
    const payload = {
      userId: target.userId,
      filePath: resolvedPath,
      contextToken: target.contextToken,
    };
    const delivery = typeof channel.sendMedia === "function"
      ? await channel.sendMedia({
          ...payload,
          source: { type: "local_file", path: resolvedPath },
          kind: normalizeText(kind) || "auto",
          caption: normalizeText(caption),
          fileName: normalizeText(fileName),
        })
      : await channel.sendFile(payload);
    await channel.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    return {
      channelId: target.channelId,
      userId: target.userId,
      filePath: resolvedPath,
      deliveryKind: normalizeText(delivery?.deliveryKind),
    };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChannelFileService };
