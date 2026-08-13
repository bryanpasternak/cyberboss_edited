const { OneBotClient } = require("./onebot-client");
const { createQqInboundFilter } = require("./message-utils");
const { sendQqMedia } = require("./media-send");

function createQqChannelAdapter(config, { identityMapStore = null, client = null } = {}) {
  const inboundFilter = createQqInboundFilter();
  const oneBot = client || new OneBotClient({
    url: config.qqWsUrl,
    accessToken: config.qqAccessToken,
    selfId: config.qqSelfId,
  });

  function resolveAccount() {
    const selfId = normalizeId(config.qqSelfId);
    if (!normalizeText(config.qqWsUrl)) throw new Error("CYBERBOSS_QQ_WS_URL is required");
    if (!selfId) throw new Error("CYBERBOSS_QQ_SELF_ID is required");
    return {
      accountId: `qq:${selfId}`,
      selfId,
      wsUrl: normalizeText(config.qqWsUrl),
    };
  }

  return {
    describe() {
      return {
        id: "qq",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.qqWsUrl,
        selfId: normalizeId(config.qqSelfId),
        capabilities: {
          channelId: "qq",
          showThinking: false,
          supportsTyping: false,
          supportsAttachments: true,
          supportsChunkConfig: false,
        },
      };
    },
    async login() {
      const account = resolveAccount();
      const info = await oneBot.callAction("get_login_info", {});
      console.log(`NapCat QQ connected: ${info?.nickname || "(unknown)"} (${info?.user_id || account.selfId})`);
    },
    printAccounts() {
      const account = resolveAccount();
      console.log(`- ${account.accountId}`);
      console.log(`  selfId: ${account.selfId}`);
      console.log(`  wsUrl: ${account.wsUrl}`);
    },
    resolveAccount,
    getKnownContextTokens() {
      return {};
    },
    rememberContextToken() {
      return "";
    },
    loadSyncBuffer() {
      return "";
    },
    saveSyncBuffer() {},
    async getUpdates({ timeoutMs = 30_000 } = {}) {
      const events = await oneBot.getEvents({ timeoutMs });
      return { ret: 0, msgs: events, get_updates_buf: "" };
    },
    normalizeIncomingMessage(event) {
      return inboundFilter.normalize(event, config, resolveAccount(), identityMapStore);
    },
    async sendText({ userId, text, contextToken = "" }) {
      const targetUserId = resolveQqUserId(userId, contextToken);
      if (!targetUserId) throw new Error("QQ sendText requires a numeric user ID");
      const content = String(text || "").trim();
      if (!content) return;
      await oneBot.callAction("send_private_msg", {
        user_id: targetUserId,
        message: content,
      });
    },
    async sendTyping() {},
    async sendMedia({ userId, filePath = "", source = null, kind = "auto", caption = "", fileName = "", contextToken = "" }) {
      const targetUserId = resolveQqUserId(userId, contextToken);
      if (!targetUserId) throw new Error("QQ sendMedia requires a numeric user ID");
      const resolvedPath = String(source?.path || filePath || "").trim();
      if (!resolvedPath) throw new Error("QQ sendMedia requires a local file path");
      return sendQqMedia({ oneBot, config, userId: targetUserId, filePath: resolvedPath, kind, caption, fileName });
    },
    async sendFile(payload) {
      return this.sendMedia({ ...payload, kind: "auto" });
    },
    close() {
      oneBot.close();
    },
  };
}

function resolveQqUserId(userId, contextToken = "") {
  const token = normalizeText(contextToken);
  const candidate = token.startsWith("qq:") ? token.slice(3).trim() : normalizeId(userId);
  return /^\d+$/.test(candidate) ? candidate : "";
}

function normalizeId(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createQqChannelAdapter, resolveQqUserId };
