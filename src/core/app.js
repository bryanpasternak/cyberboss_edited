const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const { buildWeixinHelpText } = require("./command-registry");
const { resolvePreferredSenderId } = require("./default-targets");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const {
  createReminderInterpreter,
  formatDelayText,
  looksLikeReminderIntent,
  resolveReminderDueAtMs,
} = require("./reminder-interpreter");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.runtimeAdapter = createCodexRuntimeAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    this.threadStateStore = new ThreadStateStore();
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.systemMessageDispatcher = null;
    this.reminderInterpreter = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
    });
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      void this.handleRuntimeEvent(event);
    });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] codexEndpoint=${runtimeState.endpoint}`);
    console.log(`[cyberboss] codexModels=${runtimeState.models.length}`);
    console.log("[cyberboss] 最小消息链路已启动，正在等待微信消息。");
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }

    const shutdown = createShutdownController(async () => {
      if (this.reminderInterpreter) {
        await this.reminderInterpreter.close().catch(() => {});
      }
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await this.flushDueReminders(account);
          await this.flushPendingSystemMessages();
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: this.channelAdapter.loadSyncBuffer(),
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = Array.isArray(response?.msgs) ? response.msgs : [];
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          await this.flushDueReminders(account);
          await this.flushPendingSystemMessages();
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("微信会话已失效，请重新执行 `npm run login`");
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      await this.runtimeAdapter.close();
    }
  }

  async sendTimelineScreenshot(args = []) {
    const senderId = this.resolveDefaultTerminalUser();
    if (!senderId) {
      throw new Error("无法确定时间轴截图要发送给哪个微信用户，先配置 CYBERBOSS_ALLOWED_USER_IDS");
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[senderId] || "";
    if (!contextToken) {
      throw new Error(`找不到用户 ${senderId} 的 context token，先让这个用户和 bot 聊过一次`);
    }

    const normalizedArgs = Array.isArray(args)
      ? args.map((value) => String(value ?? "")).filter(Boolean)
      : [];
    const outputFile = resolveTimelineScreenshotOutput(normalizedArgs);
    const finalArgs = outputFile
      ? normalizedArgs
      : [...normalizedArgs, "--output", path.join(os.tmpdir(), `cyberboss-timeline-${Date.now()}.png`)];
    const savedPath = resolveTimelineScreenshotOutput(finalArgs);

    await this.timelineIntegration.runSubcommand("screenshot", finalArgs);
    await this.channelAdapter.sendFile({
      userId: senderId,
      filePath: savedPath,
      contextToken,
    });
    return { userId: senderId, filePath: savedPath };
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    await this.handlePreparedMessage(normalized, { allowCommands: true });
  }

  resolveDefaultTerminalUser() {
    return resolvePreferredSenderId({
      config: this.config,
      accountId: this.channelAdapter.resolveAccount().accountId,
      sessionStore: this.runtimeAdapter.getSessionStore(),
    });
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    if (allowCommands && await this.tryHandleReminderIntent(normalized)) {
      return;
    }

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
    });

    await this.channelAdapter.sendTyping({
      userId: normalized.senderId,
      status: 1,
      contextToken: normalized.contextToken,
    }).catch(() => {});

    try {
      const result = await this.runtimeAdapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: normalized.text,
        model: this.runtimeAdapter.getSessionStore().getCodexParamsForWorkspace(bindingKey, workspaceRoot).model,
        metadata: {
          workspaceId: normalized.workspaceId,
          accountId: normalized.accountId,
          senderId: normalized.senderId,
        },
      });
      await this.streamDelivery.finishTurn({
        threadId: result.threadId,
        finalText: result.text,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `处理失败：${messageText}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    } finally {
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
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

  async tryHandleReminderIntent(normalized) {
    if (!looksLikeReminderIntent(normalized.text)) {
      return false;
    }

    const parsed = await this.interpretReminderWithModel(normalized.text).catch(() => null);
    if (!parsed || !parsed.schedule) {
      return false;
    }

    const dueAtMs = resolveReminderDueAtMs(parsed);
    if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
      return false;
    }

    await this.createReminderFromInterpretation(normalized, {
      dueAtMs,
      text: parsed.message,
    });
    return true;
  }

  async ensureReminderInterpreter() {
    if (this.reminderInterpreter) {
      return this.reminderInterpreter;
    }
    const interpreter = createReminderInterpreter(this.config);
    await interpreter.connect();
    this.reminderInterpreter = interpreter;
    return interpreter;
  }

  async interpretReminderWithModel(userText) {
    const interpreter = await this.ensureReminderInterpreter();
    return interpreter.interpret(userText);
  }

  async createReminderFromInterpretation(normalized, parsed) {
    const contextToken = normalized.contextToken || this.channelAdapter.getKnownContextTokens()[normalized.senderId] || "";
    if (!contextToken) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "当前缺少 context_token，暂时无法创建提醒。",
        contextToken: normalized.contextToken,
      }).catch(() => {});
      return;
    }

    const reminder = this.reminderQueue.enqueue({
      id: crypto.randomUUID(),
      accountId: normalized.accountId,
      senderId: normalized.senderId,
      contextToken,
      text: String(parsed.text || "").trim(),
      dueAtMs: parsed.dueAtMs,
      createdAt: new Date().toISOString(),
    });

    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已加入提醒队列。\n\n时间: ${formatDelayText(reminder.dueAtMs - Date.now())} 后\n内容: ${reminder.text}`,
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
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
          text: buildReminderSystemTrigger(reminder),
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

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (threadState?.status === "running" || threadState?.pendingApproval?.requestId) {
      return false;
    }
    await this.handlePreparedMessage(prepared, { allowCommands: false });
    return true;
  }

  async dispatchChannelCommand(normalized, command) {
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
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "用法：/bind /绝对路径",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "只支持绝对路径绑定。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `项目不存在：${workspaceRoot}`,
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
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已绑定项目。\n\nworkspace: ${workspaceRoot}`,
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
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const usage = this.threadStateStore.getLatestUsage();
    const lines = [
      `workspace: ${workspaceRoot}`,
      `thread: ${threadId || "(none)"}`,
      `status: ${threadState?.status || "idle"}`,
      `model: ${this.runtimeAdapter.getSessionStore().getCodexParamsForWorkspace(bindingKey, workspaceRoot).model || "(default)"}`,
    ];
    if (usage) {
      const usageParts = [];
      if (usage.modelContextWindow > 0 && usage.lastTotalTokens > 0) {
        usageParts.push(`last ${formatCompactNumber(usage.lastTotalTokens)}/${formatCompactNumber(usage.modelContextWindow)}`);
      } else if (usage.lastTotalTokens > 0) {
        usageParts.push(`last ${formatCompactNumber(usage.lastTotalTokens)}`);
      }
      if (usage.primaryUsedPercent > 0) {
        usageParts.push(`5h ${usage.primaryUsedPercent}%`);
      }
      if (usage.secondaryUsedPercent > 0) {
        usageParts.push(`7d ${usage.secondaryUsedPercent}%`);
      }
      if (usageParts.length) {
        lines.push(`usage: ${usageParts.join(" | ")}`);
      }
    }
    await this.channelAdapter.sendText({
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
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已切到新线程草稿。\n\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeCommandArgument(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "用法：/switch <threadId>",
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
    await this.runtimeAdapter.resumeThread({ threadId: targetThreadId });
    this.runtimeAdapter.getSessionStore().setThreadIdForWorkspace(bindingKey, workspaceRoot, targetThreadId);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已切换线程。\n\nworkspace: ${workspaceRoot}\nthread: ${targetThreadId}`,
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
    if (!threadId || !threadState?.turnId || threadState.status !== "running") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "当前没有正在运行的线程。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已发送停止请求。\n\nthread: ${threadId}`,
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
    if (!threadId || !approval?.requestId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "当前没有待处理的授权请求。",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const decision = command.name === "no" ? "decline" : "accept";
    await this.runtimeAdapter.respondApproval({
      requestId: approval.requestId,
      decision,
    });
    if (command.name === "always" && decision === "accept") {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = command.name === "always"
      ? "已记住该命令前缀，当前项目后续相同命令将自动放行。"
      : (command.name === "yes" ? "已允许本次请求。" : "已拒绝本次请求。");
    await this.channelAdapter.sendText({
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
    const currentModel = sessionStore.getCodexParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `当前模型: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`可用模型: ${catalog.models.map((item) => item.model).join("、")}`);
      } else {
        lines.push("可用模型: (未获取到模型列表)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const matched = findModelByQuery(catalog?.models || [], query);
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `未找到模型：${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setCodexParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已切换模型。\n\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event || event.type !== "runtime.approval.requested") {
      return;
    }
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = this.runtimeAdapter.getSessionStore().getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    if (!matchesCommandPrefix(event.payload.commandTokens, allowlist)) {
      return;
    }
    await this.runtimeAdapter.respondApproval({
      requestId: event.payload.requestId,
      decision: "accept",
    }).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }
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
    || String(error?.message || "").includes("会话已失效");
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
    return "微信会话已失效，请重新执行 `npm run login`";
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

function normalizeWorkspacePath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAbsoluteWorkspacePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function matchesCommandPrefix(commandTokens, allowlist) {
  const normalizedCommandTokens = Array.isArray(commandTokens)
    ? commandTokens.map((part) => normalizeCommandArgument(part)).filter(Boolean)
    : [];
  if (!normalizedCommandTokens.length || !Array.isArray(allowlist) || !allowlist.length) {
    return false;
  }
  return allowlist.some((prefix) => {
    if (!Array.isArray(prefix) || !prefix.length || prefix.length > normalizedCommandTokens.length) {
      return false;
    }
    return prefix.every((part, index) => normalizeCommandArgument(part) === normalizedCommandTokens[index]);
  });
}

function buildReminderSystemTrigger(reminder) {
  const reminderText = String(reminder?.text || "").trim();
  return `这条 reminder 已到期。\n内容：${reminderText}`;
}

function resolveTimelineScreenshotOutput(args) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    if (String(normalizedArgs[index] || "").trim() !== "--output") {
      continue;
    }
    return String(normalizedArgs[index + 1] || "").trim();
  }
  return "";
}
