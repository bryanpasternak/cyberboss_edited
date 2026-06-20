const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createTelegramChannelAdapter } = require("../adapters/channel/telegram");
const { persistIncomingTelegramAttachments } = require("../adapters/channel/telegram/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const {
  buildWeixinHelpText,
  buildTelegramHelpText,
  buildChannelHelpText,
  isCommandSupportedOnChannel,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { ChannelRouter } = require("./channel-router");
const { LastActiveChannelStore } = require("./last-active-channel-store");
const { IdentityMapStore } = require("./identity-map-store");
const { DRIVE_KEYS } = require("../services/desire-service");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { createChatMemoryRuntime } = require("../services/chat-memory");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const DEFAULT_MAX_MIN_CHUNK = MAX_MIN_WEIXIN_CHUNK;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

function buildEnabledChannels(config, { identityMapStore }) {
  const channels = new Map();
  const requestedIds = Array.isArray(config.channels) && config.channels.length
    ? config.channels.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean)
    : [(config.channel || "weixin").toLowerCase()];
  const seen = new Set();
  for (const id of requestedIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id === "weixin") {
      channels.set("weixin", createWeixinChannelAdapter(config));
    } else if (id === "telegram") {
      channels.set("telegram", createTelegramChannelAdapter(config, { identityMapStore }));
    } else {
      console.warn(`[cyberboss] unknown channel id=${id}, skipped`);
    }
  }
  if (!channels.size) {
    channels.set("weixin", createWeixinChannelAdapter(config));
  }
  return channels;
}

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.identityMapStore = new IdentityMapStore({ filePath: config.identityMapFile });
    this.lastActiveChannelStore = new LastActiveChannelStore({ filePath: config.lastActiveChannelFile });
    this.channels = buildEnabledChannels(config, { identityMapStore: this.identityMapStore });
    this.channelRouter = new ChannelRouter({
      channels: [...this.channels.values()],
      lastActiveStore: this.lastActiveChannelStore,
      defaultChannelId: config.defaultOutboundChannel || "weixin",
    });
    // Backwards-compat alias: project tooling / sticker / timeline still call this.channelAdapter.
    // Always points to the weixin channel when present, otherwise the first enabled channel.
    this.channelAdapter = this.channels.get("weixin") || this.channels.values().next().value;
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.threadStateStore = new ThreadStateStore();
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.chatMemory = createChatMemoryRuntime({ config, systemMessageQueue: this.systemMessageQueue });
    this.projectServices.chatMemory = this.chatMemory.memory;
    this.projectServices.promiseMemory = this.chatMemory.promises;
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this._activeReplyChannel = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      channelRouter: this.channelRouter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
    });
    this.pendingOperationByRunKey = new Map();
    this.pendingDesireActionByRunKey = new Map();
    this._aiReplyTextAccumulator = new Map();
    this._chatMemoryReplyAccumulator = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  resolveChannelForSender(senderId) {
    return this.channelRouter.pickChannelForSender(senderId) || this.channelAdapter;
  }

  resolveChannelById(channelId) {
    return this.channelRouter.getChannel(channelId) || null;
  }

  get currentChannel() {
    return this._activeReplyChannel || this.channelAdapter;
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channels: this.channelRouter.describeAll(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login(channelId = "") {
    const targetId = String(channelId || "").trim().toLowerCase()
      || this.config.channel
      || "weixin";
    const channel = this.channels.get(targetId);
    if (!channel) {
      throw new Error(`Channel "${targetId}" is not enabled. Set CYBERBOSS_CHANNELS to include it.`);
    }
    await channel.login();
  }

  printAccounts() {
    for (const [channelId, channel] of this.channels.entries()) {
      console.log(`# Channel: ${channelId}`);
      try {
        channel.printAccounts();
      } catch (error) {
        console.log(`  (failed to read accounts: ${error.message})`);
      }
      console.log("");
    }
  }

  async start() {
    const accountsByChannelId = new Map();
    for (const [channelId, channel] of this.channels.entries()) {
      try {
        accountsByChannelId.set(channelId, channel.resolveAccount());
      } catch (error) {
        throw new Error(`Channel "${channelId}" is not configured: ${error.message}`);
      }
    }
    const weixinAccount = accountsByChannelId.get("weixin") || accountsByChannelId.values().next().value;
    this.activeAccountId = weixinAccount?.accountId || "";
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: this.activeAccountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    await this.restoreBoundThreadSubscriptions();
    this.chatMemory.scheduler?.start?.();

    console.log("[cyberboss] bootstrap ok");
    for (const [channelId, channel] of this.channels.entries()) {
      const account = accountsByChannelId.get(channelId) || {};
      const description = channel.describe();
      console.log(`[cyberboss] channel=${channelId} account=${account.accountId || "(unknown)"} baseUrl=${description.baseUrl || ""}`);
    }
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[cyberboss] bridge loop started; waiting for inbound messages.");
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }

    const shutdown = createShutdownController(async () => {
      this.clearPendingImageInboundTimers();
      this.chatMemory.scheduler?.stop?.();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      const pollers = [...this.channels.entries()].map(([channelId, channel]) => this.runChannelPollLoop({
        shutdown,
        channelId,
        channel,
        weixinAccount,
      }));
      await Promise.all(pollers);
    } finally {
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
      this.chatMemory.scheduler?.stop?.();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async runChannelPollLoop({ shutdown, channelId, channel, weixinAccount }) {
    let consecutiveFailures = 0;
    const isWeixinChannel = channelId === "weixin";
    while (!shutdown.stopped) {
      try {
        if (isWeixinChannel && weixinAccount) {
          await Promise.all([
            this.flushDueReminders(weixinAccount),
            this.flushDuePromises(weixinAccount),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(weixinAccount),
          ]);
        }
        const requestArgs = { timeoutMs: this.resolveLongPollTimeoutMs() };
        if (isWeixinChannel) {
          requestArgs.syncBuffer = channel.loadSyncBuffer();
        }
        const response = await channel.getUpdates(requestArgs);
        if (isWeixinChannel) {
          assertWeixinUpdateResponse(response);
        }
        consecutiveFailures = 0;
        const messages = isWeixinChannel
          ? sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : [])
          : (Array.isArray(response?.msgs) ? response.msgs : []);
        for (const message of messages) {
          if (shutdown.stopped) break;
          await this.handleIncomingMessageFromChannel(channelId, channel, message);
        }
        if (isWeixinChannel && weixinAccount) {
          await Promise.all([
            this.flushDueReminders(weixinAccount),
            this.flushDuePromises(weixinAccount),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(weixinAccount),
          ]);
        }
      } catch (error) {
        if (shutdown.stopped) break;
        if (isWeixinChannel && isSessionExpiredError(error)) {
          throw new Error("The WeChat session has expired. Run `npm run login` again.");
        }
        consecutiveFailures += 1;
        const causeText = error?.cause
          ? ` cause=${error.cause.code || ""} ${error.cause.message || error.cause}`
          : "";
        console.error(`[cyberboss] channel=${channelId} poll failed: ${formatErrorMessage(error)}${causeText}`);
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
      }
    }
  }

  async handleIncomingMessageFromChannel(channelId, channel, message) {
    const normalized = channel.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }
    if (channelId === "telegram" && normalized.canonicalSenderId === "" && normalized.externalSenderId) {
      await this.handleUnlinkedTelegramInbound(channel, normalized);
      return;
    }
    this.lastActiveChannelStore.mark(normalized.senderId, channelId);
    this.primeDeferredRepliesForSender(normalized);
    await this.handlePreparedMessage(normalized, { allowCommands: true, channelId, channel });
  }

  async handleUnlinkedTelegramInbound(channel, normalized) {
    const text = String(normalized.text || "").trim();
    const argMatch = text.match(/^\/link\s+([A-Z0-9]{4,12})\s*$/i);
    if (argMatch) {
      const consumed = this.identityMapStore.consumeLinkCode(argMatch[1]);
      if (!consumed) {
        await channel.sendText({
          userId: normalized.chatId,
          text: "❌ 这个 link code 无效或已过期。请到微信端重新发送 /link。",
        }).catch(() => {});
        return;
      }
      this.identityMapStore.link({
        channel: "telegram",
        externalId: normalized.externalSenderId,
        canonicalSenderId: consumed.canonicalSenderId,
        canonicalAccountId: consumed.canonicalAccountId || "",
        metadata: {
          username: normalized.senderProfile?.username || "",
          firstName: normalized.senderProfile?.firstName || "",
        },
      });
      this.lastActiveChannelStore.mark(consumed.canonicalSenderId, "telegram");
      await channel.sendText({
        userId: normalized.chatId,
        text: `✅ 已绑定到身份 ${consumed.canonicalSenderId}。两端共享同一份对话上下文，最近活跃端会收到回复。`,
      }).catch(() => {});
      return;
    }
    await channel.sendText({
      userId: normalized.chatId,
      text: [
        "👋 你还没有绑定身份。",
        "请先在微信端发送 /link 获取 6 位绑定码，",
        "然后在这里发送：/link <code> 完成绑定。",
        "码 10 分钟内有效。",
      ].join("\n"),
    }).catch(() => {});
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const channel = this.channels.get("weixin");
    if (!channel) return;
    return this.handleIncomingMessageFromChannel("weixin", channel, message);
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands, channelId = "", channel = null } = {}) {
    const sourceChannelId = String(channelId || normalized?.provider || "").trim().toLowerCase() || "weixin";
    const sourceChannel = channel || this.resolveChannelById(sourceChannelId) || this.channelAdapter;
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
      channelId: sourceChannelId,
    });

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command, { channelId: sourceChannelId, channel: sourceChannel });
      return;
    }

    // 关键词触发：扫描用户消息中的亲密/情绪关键词，自动提升对应驱动
    if (this.projectServices?.desire && normalized.provider !== "system") {
      this.projectServices.desire.scanTextTriggers(normalized.text || "");
    }

    // 记忆关键词触发：检测用户是否暗示需要记忆操作
    if (normalized.provider !== "system") {
      const MEMORY_TRIGGERS = ['记住', '以后', '别忘了', '记下来', '保存', '存档', '还记得'];
      const matchedTrigger = MEMORY_TRIGGERS.find(kw => (normalized.text || '').includes(kw));
      if (matchedTrigger) {
        normalized._memoryHint = matchedTrigger;
      }
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot, { channelId: sourceChannelId, channel: sourceChannel });
    if (!prepared) {
      return;
    }
    if (!prepared.channelId) {
      prepared.channelId = sourceChannelId;
    }
    if (!prepared.bindingKey) {
      prepared.bindingKey = bindingKey;
    }
    if (!prepared.workspaceRoot) {
      prepared.workspaceRoot = workspaceRoot;
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      if (typeof this.capturePreparedUserMessage === "function") {
        await this.capturePreparedUserMessage({ prepared, bindingKey, workspaceRoot, channelId: sourceChannelId });
      }
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    if (typeof this.capturePreparedUserMessage === "function") {
      await this.capturePreparedUserMessage({ prepared, bindingKey, workspaceRoot, channelId: sourceChannelId });
    }
    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    const outboundChannel = this.resolveChannelById(prepared?.channelId)
      || this.resolveChannelForSender(prepared?.senderId)
      || this.channelAdapter;
    await outboundChannel.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    try {
      const model = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          _memoryHint: prepared._memoryHint || '',
          provider: prepared.provider,
        },
      });
      await this.chatMemory?.capture?.appendTurnLinked?.({
        sourceEventId: prepared._chatMemorySourceEventId || "",
        threadId: turn.threadId,
        turnId: turn.turnId,
        bindingKey,
        workspaceRoot,
      }).catch((error) => {
        console.warn(`[chat-memory] turn link failed: ${error.message}`);
      });
      const desireAction = prepared?.provider === "system" ? extractDesireActionFromSystemText(runtimeTurn.text) : "";
      if (desireAction) {
        this.pendingDesireActionByRunKey.set(buildRunKey(turn.threadId, turn.turnId), desireAction);
        if (turn.turnId) {
          this.pendingDesireActionByRunKey.set(buildRunKey(turn.threadId, ""), desireAction);
        }
      }
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      console.error(`[cyberboss] dispatchPreparedTurn failed workspace=${workspaceRoot} binding=${bindingKey} error=${messageText}`);
      await this.chatMemory?.capture?.appendDispatchFailed?.({
        sourceEventId: prepared._chatMemorySourceEventId || "",
        text: messageText,
        bindingKey,
        workspaceRoot,
      }).catch((captureError) => {
        console.warn(`[chat-memory] dispatch failure capture failed: ${captureError.message}`);
      });
      await outboundChannel.sendText({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  async buildRuntimeTurn({ prepared, model = "" }) {
    if (prepared?.provider === "system") {
      const promiseContext = typeof this.buildPromiseCheckText === "function"
        ? await this.buildPromiseCheckText({
            prepared,
            text: String(prepared.text || "").trim(),
          })
        : "";
      return {
        text: [promiseContext, String(prepared.text || "").trim()].filter(Boolean).join("\n\n").trim(),
        attachments: [],
      };
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
    });
    const baseText = assembleRuntimeTurnText({
        prepared,
        config: this.config,
        visionContext,
      });
    const memoryContext = typeof this.buildMemoryInjectionText === "function"
      ? await this.buildMemoryInjectionText({
          prepared,
          text: baseText,
        })
      : "";
    return {
      text: [baseText, memoryContext].filter(Boolean).join("\n\n").trim(),
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
    };
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot);
    const inboundChannel = this.resolveChannelById(prepared?.channelId)
      || this.resolveChannelForSender(prepared?.senderId)
      || this.channelAdapter;
    void inboundChannel.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      messages: remainingMessages,
      timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
    });
    if (typeof this.capturePreparedUserMessage === "function") {
      await this.capturePreparedUserMessage({
        prepared,
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        channelId: prepared.channelId || prepared.provider,
      });
    }
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      receivedAt: prepared.receivedAt,
      _memoryHint: prepared._memoryHint || '',
    });
    this.pendingInboundByScope.set(scopeKey, current);
    const inboundChannel = this.resolveChannelById(prepared?.channelId)
      || this.resolveChannelForSender(prepared?.senderId)
      || this.channelAdapter;
    void inboundChannel.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  clearPendingInboundForScope(bindingKey, workspaceRoot) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingInboundByScope.delete(scopeKey);
    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const pendingDispatch = this.mergePendingInboundDraft(draft);
      if (!pendingDispatch?.prepared) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          receivedAt: pendingDispatch.prepared.receivedAt,
          bindingKey: pendingDispatch.prepared.bindingKey,
          workspaceRoot: pendingDispatch.prepared.workspaceRoot,
          _chatMemorySourceEventId: pendingDispatch.prepared._chatMemorySourceEventId || "",
        },
      });
      if (!dispatched) {
        this.pendingInboundByScope.set(scopeKey, draft);
        continue;
      }
      if (pendingDispatch.remainingMessages.length) {
        this.pendingInboundByScope.set(scopeKey, {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: pendingDispatch.remainingMessages,
        });
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    if (queued.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
      return {
        prepared: buildMergedInboundPrepared({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: batchMessages,
        }),
        remainingMessages,
      };
    }

    if (queued.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        },
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    const blocks = queued
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);

    return {
      prepared: {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        text: [
          "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
          "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
          "",
          blocks.join("\n\n"),
        ].join("\n").trim(),
      },
      remainingMessages: [],
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot, { channelId = "", channel = null } = {}) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    const sourceChannelId = String(channelId || normalized?.provider || "").trim().toLowerCase() || "weixin";
    let persisted;
    if (sourceChannelId === "telegram") {
      const tgChannel = channel || this.resolveChannelById("telegram");
      const account = tgChannel ? tgChannel.resolveAccount() : null;
      persisted = await persistIncomingTelegramAttachments({
        attachments,
        stateDir: this.config.stateDir,
        apiBaseUrl: account?.apiBaseUrl || this.config.telegramApiBaseUrl,
        botToken: account?.botToken || this.config.telegramBotToken,
        receivedAt: normalized.receivedAt,
      });
    } else {
      persisted = await persistIncomingWeixinAttachments({
        attachments,
        stateDir: this.config.stateDir,
        cdnBaseUrl: this.config.weixinCdnBaseUrl,
        messageId: normalized.messageId,
        receivedAt: normalized.receivedAt,
      });
    }

    const responseChannel = channel || this.resolveChannelById(sourceChannelId) || this.channelAdapter;

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await responseChannel.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await responseChannel.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        const errorChannel = this.resolveChannelForSender(job.senderId) || this.channelAdapter;
        await errorChannel.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await errorChannel.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  async flushDuePromises(account) {
    if (!this.chatMemory?.promises || this.config.promiseActiveTriggerEnabled === false) {
      return;
    }
    const duePromises = this.chatMemory.promises.retrieveDueForTurn({
      now: new Date(),
      accountId: account.accountId,
      limit: 10,
    });
    const queuedIds = [];
    for (const promise of duePromises) {
      try {
        this.systemMessageQueue.enqueue({
          id: `promise:${promise.id}`,
          accountId: promise.accountId || account.accountId,
          senderId: promise.senderId || resolvePreferredSenderId({
            config: this.config,
            accountId: account.accountId,
            sessionStore: this.runtimeAdapter.getSessionStore(),
          }),
          workspaceRoot: promise.workspaceRoot || this.resolveReminderWorkspaceRoot({
            accountId: account.accountId,
            senderId: promise.senderId || "",
          }),
          text: buildPromiseSystemTrigger(promise),
          createdAt: new Date().toISOString(),
        });
        queuedIds.push(promise.id);
      } catch (error) {
        console.warn(`[chat-memory] promise queue failed: ${error.message}`);
      }
    }
    this.chatMemory.promises.markInjected(queuedIds, { at: new Date() });
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const senderId = String(message?.senderId || "").trim();
    const channelForSender = senderId ? this.resolveChannelForSender(senderId) : null;
    const tokenSource = channelForSender && typeof channelForSender.getKnownContextTokens === "function"
      ? channelForSender
      : this.channelAdapter;
    const contextTokenForSender = (tokenSource.getKnownContextTokens?.() || {})[senderId] || "";
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, contextTokenForSender);
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    if (channelForSender && !prepared.channelId) {
      try {
        prepared.channelId = channelForSender.describe()?.capabilities?.channelId
          || channelForSender.describe()?.id
          || "weixin";
      } catch {
        prepared.channelId = "weixin";
      }
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  async dispatchChannelCommand(normalized, command, { channelId = "weixin", channel = null } = {}) {
    const sourceChannelId = String(channelId || "weixin").trim().toLowerCase() || "weixin";
    const sourceChannel = channel || this.resolveChannelById(sourceChannelId) || this.channelAdapter;
    this._activeReplyChannel = sourceChannel;
    try {
      if (!isCommandSupportedOnChannel(command.name, sourceChannelId)) {
        await sourceChannel.sendText({
          userId: normalized.senderId,
          text: `⚠️ 该命令在当前渠道不支持: /${command.name}\n请输入 /help 查看可用命令。`,
          contextToken: normalized.contextToken,
        }).catch(() => {});
        return;
      }
      switch (command.name) {
        case "bind":
          await this.handleBindCommand(normalized, command);
          return;
        case "status":
          await this.handleStatusCommand(normalized);
          return;
        case "new":
          await this.handleNewCommand(normalized);
          return;
        case "reread":
          await this.handleRereadCommand(normalized);
          return;
        case "compact":
          await this.handleCompactCommand(normalized);
          return;
        case "switch":
          await this.handleSwitchCommand(normalized, command);
          return;
        case "stop":
          await this.handleStopCommand(normalized);
          return;
        case "checkin":
          await this.handleCheckinCommand(normalized, command);
          return;
        case "desire":
          await this.handleDesireCommand(normalized, command);
          return;
        case "chunk":
          await this.handleChunkCommand(normalized, command);
          return;
        case "yes":
        case "always":
        case "no":
          await this.handleApprovalCommand(normalized, command);
          return;
        case "model":
          await this.handleModelCommand(normalized, command);
          return;
        case "star":
          await this.handleStarCommand(normalized);
          return;
        case "help":
          await this.handleHelpCommand(normalized, sourceChannelId);
          return;
        case "recall":
          await this.handleRecallCommand(normalized, command);
          return;
        case "link":
          await this.handleLinkCommand(normalized, command, { channelId: sourceChannelId, channel: sourceChannel });
          return;
        case "unlink":
          await this.handleUnlinkCommand(normalized, { channelId: sourceChannelId, channel: sourceChannel });
          return;
        default:
          await sourceChannel.sendText({
            userId: normalized.senderId,
            text: buildChannelHelpText(sourceChannelId),
            contextToken: normalized.contextToken,
          });
      }
    } finally {
      this._activeReplyChannel = null;
    }
  }

  async handleLinkCommand(normalized, command, { channelId, channel }) {
    const arg = normalizeCommandArgument(command.args).toUpperCase();
    if (arg) {
      const consumed = this.identityMapStore.consumeLinkCode(arg);
      if (!consumed) {
        await channel.sendText({
          userId: normalized.senderId,
          text: "❌ 这个 link code 无效或已过期。",
          contextToken: normalized.contextToken,
        });
        return;
      }
      const externalId = channelId === "telegram"
        ? normalized.externalSenderId || ""
        : normalized.senderId;
      this.identityMapStore.link({
        channel: channelId,
        externalId,
        canonicalSenderId: consumed.canonicalSenderId,
        canonicalAccountId: consumed.canonicalAccountId || "",
        metadata: channelId === "telegram"
          ? { username: normalized.senderProfile?.username || "", firstName: normalized.senderProfile?.firstName || "" }
          : {},
      });
      this.lastActiveChannelStore.mark(consumed.canonicalSenderId, channelId);
      await channel.sendText({
        userId: normalized.senderId,
        text: `✅ 已绑定。两端从此共享同一份对话上下文。`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const result = this.identityMapStore.issueLinkCode({
      canonicalSenderId: normalized.senderId,
      canonicalAccountId: normalized.accountId || "",
      channel: channelId,
    });
    if (!result) {
      await channel.sendText({
        userId: normalized.senderId,
        text: "❌ 无法生成 link code。",
        contextToken: normalized.contextToken,
      });
      return;
    }
    const expiresAt = new Date(result.expiresAtMs).toLocaleTimeString("zh-CN", { hour12: false });
    await channel.sendText({
      userId: normalized.senderId,
      text: [
        `🔗 Link code: ${result.code}`,
        `有效期至 ${expiresAt}（10 分钟）`,
        "在另一端发送：/link " + result.code + " 完成绑定。",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleUnlinkCommand(normalized, { channelId, channel }) {
    const externalId = channelId === "telegram"
      ? normalized.externalSenderId || ""
      : normalized.senderId;
    const removed = this.identityMapStore.unlink({ channel: channelId, externalId });
    await channel.sendText({
      userId: normalized.senderId,
      text: removed ? "✅ 已解除当前渠道的身份绑定。" : "💡 当前渠道没有绑定记录。",
      contextToken: normalized.contextToken,
    });
  }

  async handleRecallCommand(normalized, command) {
    const args = normalizeCommandArgument(command.args);
    const [rawSubcommand] = args.split(/\s+/).filter(Boolean);
    const subcommand = normalizeCommandName(rawSubcommand || "status");
    const memoryService = this.chatMemory?.memory || null;
    let settings = this.chatMemory?.memory?.getSettings?.() || {
      injectEnabled: false,
      injectLimit: 0,
    };
    if (["on", "enable", "enabled"].includes(subcommand)) {
      settings = memoryService?.setInjectEnabled?.(true) || settings;
    } else if (["off", "disable", "disabled"].includes(subcommand)) {
      settings = memoryService?.setInjectEnabled?.(false) || settings;
    } else if (/^\d+$/.test(subcommand)) {
      settings = memoryService?.setInjectLimit?.(Number.parseInt(subcommand, 10)) || settings;
    } else if (!["status", "state", "help"].includes(subcommand)) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "Usage: /recall | /recall on | /recall off | /recall <number>",
        contextToken: normalized.contextToken,
      });
      return;
    }
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: [
        `🧠 auto recall: ${settings.injectEnabled ? "on" : "off"}`,
        `🧠 recall count: ${settings.injectLimit}`,
        this.config.chatMemoryEnabled ? "" : "⚠️ CYBERBOSS_CHAT_MEMORY_ENABLED is off, so capture/retrieval are disabled.",
      ].filter(Boolean).join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const storedModel = runtimeParams.model || "";
    const storedModelProvider = runtimeParams.modelProvider || this.runtimeAdapter.describe().modelProvider || "";
    const effectiveModel = this.runtimeAdapter.describe().model || storedModel;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const previousThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const nextOpeningContext = await this.buildNewThreadOpeningContext({
      previousThreadId,
      bindingKey,
      workspaceRoot,
    });
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (nextOpeningContext && typeof sessionStore.setNextOpeningContextForWorkspace === "function") {
      sessionStore.setNextOpeningContextForWorkspace(bindingKey, workspaceRoot, nextOpeningContext);
    }
    this.clearPendingInboundForScope(bindingKey, workspaceRoot);
    this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
    if (previousThreadId) {
      this.threadStateStore.applyRuntimeEvent({
        type: "runtime.turn.completed",
        payload: {
          threadId: previousThreadId,
          turnId: "",
        },
      });
    }
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async buildNewThreadOpeningContext({ previousThreadId = "", bindingKey = "", workspaceRoot = "" } = {}) {
    const blocks = [];
    try {
      const recap = await this.chatMemory?.memory?.buildThreadRecap?.({
        threadId: previousThreadId,
        bindingKey,
        workspaceRoot,
        headTurns: 15,
        tailTurns: 15,
        omitTailTurns: 2,
      });
      if (recap) {
        blocks.push(recap);
      }
    } catch (error) {
      console.warn(`[chat-memory] previous thread recap failed: ${error.message}`);
    }
    try {
      const recent = await this.chatMemory?.memory?.retrieveRecent?.({
        limit: 4,
        filters: { bindingKey, workspaceRoot },
      });
      const context = this.chatMemory?.memory?.formatForInjection?.(recent, {
        title: "这些是你和苏苏最近发生的事，你还记得很清楚：",
      });
      if (context) {
        blocks.push(context);
      }
    } catch (error) {
      console.warn(`[chat-memory] recent memory for new thread failed: ${error.message}`);
    }
    return blocks.join("\n\n").trim();
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
      });
    } catch (error) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      model: runtimeParams.model,
      modelProvider: runtimeParams.modelProvider,
    });
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleDesireCommand(normalized, command) {
    const service = this.projectServices?.desire;
    if (!service) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "Desire system is not initialized.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const args = normalizeCommandArgument(command.args);
    const [rawSubcommand, ...restTokens] = args.split(/\s+/).filter(Boolean);
    const subcommand = normalizeCommandName(rawSubcommand || "state");
    const reply = async (text) => {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
      });
    };

    if (subcommand === "help") {
      await reply(buildDesireUsageText());
      return;
    }
    if (subcommand === "on" || subcommand === "enable") {
      service.toggleDriven(true);
      await reply(`${buildDesireStateText(service.getSnapshot())}\n\nDesire-driven check-in context: on`);
      return;
    }
    if (subcommand === "off" || subcommand === "disable") {
      service.toggleDriven(false);
      await reply(`${buildDesireStateText(service.getSnapshot())}\n\nDesire-driven check-in context: off`);
      return;
    }
    if (subcommand === "tick") {
      service.tick();
      await reply(`${buildDesireStateText(service.getSnapshot())}\n\nTick applied.`);
      return;
    }
    if (subcommand === "satisfy") {
      const action = normalizeCommandArgument(restTokens[0]);
      if (!isKnownDesireAction(action)) {
        await reply("Usage: /desire satisfy <web_browse|reach_out|reflect|follow_up|seduce|vent|none>");
        return;
      }
      service.satisfyAction(action);
      await reply(`${buildDesireStateText(service.getSnapshot())}\n\nSatisfied action: ${action}`);
      return;
    }
    if (subcommand === "feed") {
      const drive = normalizeCommandArgument(restTokens[0]);
      if (!DRIVE_KEYS.includes(drive) || drive === "fatigue") {
        await reply("Usage: /desire feed <attachment|curiosity|reflection|duty|social|libido|stress> [flit|fixation] <text>");
        return;
      }
      const maybeKind = normalizeCommandArgument(restTokens[1]);
      const kind = maybeKind === "fixation" || maybeKind === "flit" ? maybeKind : "flit";
      const textStart = kind === maybeKind ? 2 : 1;
      const text = restTokens.slice(textStart).join(" ").trim();
      if (!text) {
        await reply("Usage: /desire feed <drive> [flit|fixation] <text>");
        return;
      }
      service.feedThought(text, drive, kind, kind === "fixation" ? 0.8 : 0.5);
      await reply(`${buildDesireStateText(service.getSnapshot())}\n\nThought fed: ${text.slice(0, 40)}`);
      return;
    }
    if (subcommand !== "state" && subcommand !== "status") {
      await reply(buildDesireUsageText());
      return;
    }

    await reply(buildDesireStateText(service.getSnapshot()));
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    const maxChunk = resolveChannelMaxChunkChars(this.currentChannel);
    if (!arg) {
      const current = this.currentChannel.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (1-${maxChunk}, e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > maxChunk) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${maxChunk}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.currentChannel.setMinChunkChars?.(parsed) ?? parsed;
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
  if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: "💡 There is no pending approval request right now.",
      contextToken: normalized.contextToken,
      });
      return;
    }

    if (approval?.kind === "mcp_tool_call" && command.name === "always") {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "⚠️ Persistent approval for this Codex MCP tool request is not available from WeChat.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && approvalResponse.decision === "accept") {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.currentChannel.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.currentChannel.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  async handleHelpCommand(normalized, channelId = "weixin") {
    await this.currentChannel.sendText({
      userId: normalized.senderId,
      text: buildChannelHelpText(channelId),
      contextToken: normalized.contextToken,
    });
  }

  takePendingDesireAction(threadId, turnId) {
    if (!this.pendingDesireActionByRunKey || typeof this.pendingDesireActionByRunKey.get !== "function") {
      return "";
    }
    const keys = [
      buildRunKey(threadId, turnId),
      buildRunKey(threadId, ""),
    ];
    for (const key of keys) {
      const action = this.pendingDesireActionByRunKey.get(key);
      if (!action) {
        continue;
      }
      for (const candidate of keys) {
        this.pendingDesireActionByRunKey.delete(candidate);
      }
      return action;
    }
    return "";
  }

  satisfyDesireAction(action) {
    if (!isKnownDesireAction(action) || !this.projectServices?.desire) {
      return;
    }
    try {
      this.projectServices.desire.satisfyAction(action);
      console.log(`[cyberboss] desire satisfied action=${action}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      console.warn(`[cyberboss] desire satisfy failed action=${action}: ${message}`);
    }
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async capturePreparedUserMessage({ prepared, bindingKey, workspaceRoot, channelId } = {}) {
    try {
      const sourceEventId = await this.chatMemory?.capture?.appendUserReceived?.({
        prepared,
        bindingKey,
        workspaceRoot,
        channelId,
      });
      if (prepared && sourceEventId) {
        prepared._chatMemorySourceEventId = sourceEventId;
      }
      return sourceEventId || "";
    } catch (error) {
      console.warn(`[chat-memory] user capture failed: ${error.message}`);
      return "";
    }
  }

  async buildMemoryInjectionText({ prepared, text = "", now = new Date() } = {}) {
    const blocks = [];
    try {
      if (this.chatMemory?.memory?.isInjectEnabled?.()) {
        const results = await this.chatMemory.memory.retrieveForTurn({
          text,
          prepared,
          now,
          limit: resolveRecallLimit(this.chatMemory.memory, this.config),
        });
        const context = this.chatMemory.memory.formatForInjection(results);
        if (context) {
          blocks.push(context);
        }
      }
    } catch (error) {
      console.warn(`[chat-memory] retrieval failed: ${error.message}`);
    }
    try {
      if (this.chatMemory?.promises && this.config.promisePassiveInjectEnabled !== false) {
        const duePromises = this.chatMemory.promises.retrieveDueForTurn({
          now,
          bindingKey: prepared?.bindingKey || "",
          workspaceRoot: prepared?.workspaceRoot || "",
          accountId: prepared?.accountId || "",
          limit: 2,
        });
        const dueContext = this.chatMemory.promises.formatDueForInjection(duePromises);
        if (dueContext) {
          blocks.push(dueContext);
          this.chatMemory.promises.markInjected(duePromises.map((promise) => promise.id), { at: now });
        }
      }
    } catch (error) {
      console.warn(`[chat-memory] promise retrieval failed: ${error.message}`);
    }
    return blocks.filter(Boolean).join("\n\n");
  }

  async buildPromiseCheckText({ prepared, text = "", now = new Date() } = {}) {
    try {
      if (!this.chatMemory?.promises || this.config.promisePassiveInjectEnabled === false) {
        return "";
      }
      const duePromises = this.chatMemory.promises.retrieveDueForTurn({
        now,
        bindingKey: prepared?.bindingKey || "",
        workspaceRoot: prepared?.workspaceRoot || "",
        accountId: prepared?.accountId || "",
        limit: 2,
      });
      if (!duePromises.length) {
        return "";
      }
      const context = this.chatMemory.promises.formatDueForInjection(duePromises);
      this.chatMemory.promises.markInjected(duePromises.map((promise) => promise.id), { at: now });
      return context;
    } catch (error) {
      console.warn(`[chat-memory] promise check failed: ${error.message}`);
      return "";
    }
  }

  async captureRuntimeTurnResult(event, linked) {
    if (!this.chatMemory?.capture && !this.chatMemory?.promises) {
      return;
    }
    const threadId = event?.payload?.threadId || "";
    const turnId = event?.payload?.turnId || "";
    const runKey = buildRunKey(threadId, turnId);
    const threadKey = buildRunKey(threadId, "");
    const accumulator = this._chatMemoryReplyAccumulator && typeof this._chatMemoryReplyAccumulator.get === "function"
      ? this._chatMemoryReplyAccumulator
      : new Map();
    const text = normalizeText(
      accumulator.get(runKey)
      || accumulator.get(threadKey)
      || event?.payload?.text
      || ""
    );
    if (event?.type === "runtime.turn.completed") {
      await this.chatMemory?.capture?.appendAssistantCompleted?.({
        threadId,
        turnId,
        text,
        linked,
      }).catch((error) => {
        console.warn(`[chat-memory] assistant capture failed: ${error.message}`);
      });
      if (text && this.chatMemory?.promises) {
        const created = await this.chatMemory.promises.captureAssistantPromise({
          threadId,
          turnId,
          text,
          bindingKey: linked?.bindingKey || "",
          workspaceRoot: linked?.workspaceRoot || "",
          accountId: linked?.accountId || "",
          senderId: linked?.senderId || "",
          source: {
            threadId,
            turnId,
          },
        }).catch((error) => {
          console.warn(`[chat-memory] promise capture failed: ${error.message}`);
          return [];
        });
        if (Array.isArray(created) && created.length && this.config.promiseActiveTriggerEnabled) {
          for (const promise of created) {
            this.chatMemory.promises.maybeQueueActiveCheck(promise);
          }
        }
      }
    } else if (event?.type === "runtime.turn.failed") {
      await this.chatMemory?.capture?.appendAssistantFailed?.({
        threadId,
        turnId,
        text: text || event?.payload?.text || "",
        linked,
      }).catch((error) => {
        console.warn(`[chat-memory] assistant failure capture failed: ${error.message}`);
      });
    }
    if (threadId) {
      accumulator.delete(runKey);
      accumulator.delete(threadKey);
    }
  }

  async handleRuntimeEvent(event) {
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    const aiReplyTextAccumulator = ensureMapAccumulator(this, "_aiReplyTextAccumulator");
    const chatMemoryReplyAccumulator = ensureMapAccumulator(this, "_chatMemoryReplyAccumulator");

    // 积累 AI 回复文本，用于关键词触发
    if (event.type === "runtime.reply.completed" && event.payload?.text && event.payload?.threadId) {
      const tid = event.payload.threadId;
      const existing = aiReplyTextAccumulator.get(tid) || "";
      aiReplyTextAccumulator.set(tid, existing + "\n" + event.payload.text);
      const runKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const runExisting = chatMemoryReplyAccumulator.get(runKey) || "";
      chatMemoryReplyAccumulator.set(runKey, `${runExisting}\n${event.payload.text}`.trim());
      if (event.payload.turnId) {
        const threadKey = buildRunKey(event.payload.threadId, "");
        const threadExisting = chatMemoryReplyAccumulator.get(threadKey) || "";
        chatMemoryReplyAccumulator.set(threadKey, `${threadExisting}\n${event.payload.text}`.trim());
      }
    }

    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      // 扫描 AI 回复中的关键词
      if (this.projectServices?.desire && event.type === "runtime.turn.completed") {
        const tid = event.payload?.threadId || "";
        const aiText = aiReplyTextAccumulator.get(tid) || event.payload?.text || "";
        if (aiText) {
          this.projectServices.desire.scanTextTriggers(aiText);
        }
        aiReplyTextAccumulator.delete(tid);
      }

      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      const pendingDesireAction = typeof this.takePendingDesireAction === "function"
        ? this.takePendingDesireAction(event.payload.threadId, event.payload.turnId)
        : "";
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
      const binding = linked?.bindingKey && typeof sessionStore.getBinding === "function"
        ? sessionStore.getBinding(linked.bindingKey)
        : null;
      await this.captureRuntimeTurnResult(event, {
        ...(linked || {}),
        accountId: normalizeText(binding?.accountId),
        senderId: normalizeText(binding?.senderId),
      });
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        console.log(
          `[cyberboss] runtime event ${event.type} thread=${event.payload.threadId} turn=${event.payload.turnId || "(empty)"} linked=${linked?.workspaceRoot || "(none)"}`
        );
        if (event.type === "runtime.turn.failed") {
          await this.sendFailureToThread(
            event.payload.threadId,
            event.payload.text || "❌ Execution failed",
            failureReplyTarget,
          );
        } else if (pendingDesireAction && typeof this.satisfyDesireAction === "function") {
          this.satisfyDesireAction(pendingDesireAction);
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          const compactChannel = this.resolveChannelForSender(pendingOperation.userId) || this.channelAdapter;
          await compactChannel.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    const channel = this.resolveChannelById(target.channelId)
      || this.resolveChannelForSender(target.userId)
      || this.channelAdapter;
    await channel.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      return;
    }
    const channel = this.resolveChannelById(target.channelId)
      || this.resolveChannelForSender(target.userId)
      || this.channelAdapter;
    await channel.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    const channel = this.resolveChannelById(target.channelId)
      || this.resolveChannelForSender(target.userId)
      || this.channelAdapter;
    await channel.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await channel.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const channel = this.resolveChannelForSender(userId) || this.channelAdapter;
    const channelDescription = (() => {
      try { return channel.describe(); } catch { return null; }
    })();
    const channelId = channelDescription?.capabilities?.channelId
      || channelDescription?.id
      || "weixin";

    if (channelId === "telegram") {
      const bindings = this.identityMapStore.listBindingsForCanonical(userId);
      const tgBinding = bindings.find((entry) => entry.channel === "telegram");
      if (!tgBinding) {
        return null;
      }
      return {
        userId: tgBinding.externalId,
        contextToken: `tg:${tgBinding.externalId}`,
        provider: "telegram",
        channelId: "telegram",
      };
    }

    const contextToken = (channel.getKnownContextTokens?.() || {})[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: channelId,
      channelId,
    };
  }
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function ensureMapAccumulator(target, propertyName) {
  if (!target || typeof propertyName !== "string") {
    return new Map();
  }
  const current = target[propertyName];
  if (current && typeof current.get === "function" && typeof current.set === "function" && typeof current.delete === "function") {
    return current;
  }
  const next = new Map();
  target[propertyName] = next;
  return next;
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
    channelId: normalizeText(target.channelId),
  };
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildDesireStateText(snapshot) {
  const state = snapshot?.state || {};
  const drive = snapshot?.drive || state.drive || {};
  const intent = snapshot?.intent || {};
  const thoughts = Array.isArray(snapshot?.thoughts) ? snapshot.thoughts : [];
  const lines = [
    "Desire state",
    `intent: ${intent.wantAction || "none"} (${intent.driveKey || "unknown"} ${formatDriveNumber(intent.score)})`,
    `reason: ${normalizeText(intent.reason) || "-"}`,
    `driven: ${snapshot?.drivenBehaviorEnabled || state.drivenBehaviorEnabled ? "on" : "off"}`,
    "",
    ...DRIVE_KEYS.map((key) => `${key}: ${formatDriveBar(drive[key])} ${formatDrivePercent(drive[key])}`),
    "",
    `thoughts: ${thoughts.length}`,
  ];
  const preview = thoughts.slice(0, 5).map((thought) => {
    const kind = thought.kind === "fixation" ? "*" : "-";
    return `${kind} ${normalizeText(thought.text).slice(0, 36)} (${thought.drive} ${formatDrivePercent(thought.strength)})`;
  });
  if (preview.length) {
    lines.push(...preview);
  }
  return lines.join("\n");
}

function buildDesireUsageText() {
  return [
    "Usage:",
    "/desire",
    "/desire on",
    "/desire off",
    "/desire tick",
    "/desire feed <drive> [flit|fixation] <text>",
    "/desire satisfy <web_browse|reach_out|reflect|follow_up|seduce|vent|none>",
  ].join("\n");
}

function extractDesireActionFromSystemText(text) {
  const normalized = normalizeText(text);
  if (!normalized.includes("Desire context:")) {
    return "";
  }
  const match = normalized.match(/\baction=([a-z_]+)/i);
  const action = normalizeCommandArgument(match?.[1] || "");
  return isKnownDesireAction(action) ? action : "";
}

function isKnownDesireAction(action) {
  return ["web_browse", "reach_out", "reflect", "follow_up", "seduce", "vent", "none"].includes(normalizeCommandArgument(action));
}

function formatDriveBar(value) {
  const count = Math.max(0, Math.min(10, Math.round((Number(value) || 0) * 10)));
  return `${"#".repeat(count)}${"-".repeat(10 - count)}`;
}

function formatDrivePercent(value) {
  return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
}

function formatDriveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "0.00";
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { CyberbossApp };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveChannelMaxChunkChars(channel) {
  const value = typeof channel?.getMaxChunkChars === "function"
    ? Number(channel.getMaxChunkChars())
    : DEFAULT_MAX_MIN_CHUNK;
  return Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_MAX_MIN_CHUNK;
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (normalized[0] === "mcp_tool" && normalized[1] === "cyberboss_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? responseByCommand[commandName]
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function buildPromiseSystemTrigger(promise) {
  return [
    "Promise todo due for model self-check.",
    `Promise: ${normalizeText(promise?.text)}`,
    `Due type: ${normalizeText(promise?.dueType) || "unknown"}`,
    promise?.dueAt ? `Due at: ${normalizeText(promise.dueAt)}` : "",
    "Check whether to naturally continue or act on this promise. Do not mention internal scheduling.",
  ].filter(Boolean).join("\n");
}

function resolveRecallLimit(memoryService, config = {}) {
  const serviceLimit = typeof memoryService?.getInjectLimit === "function"
    ? memoryService.getInjectLimit()
    : null;
  if (Number.isFinite(serviceLimit)) {
    return Math.max(0, serviceLimit);
  }
  const configLimit = Number(config?.chatMemoryInjectLimit);
  if (Number.isFinite(configLimit)) {
    return Math.max(0, configLimit);
  }
  return 6;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
