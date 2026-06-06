const path = require("path");
const os = require("os");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const { resolveClaudeIpcEndpoint } = require("./ipc-endpoint");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByWorkspace = new Map();
  const pendingApprovals = new Map();
  let globalListener = null;
  const stateDir = config.stateDir || path.join(os.homedir(), ".cyberboss");
  const ipcEndpoint = resolveClaudeIpcEndpoint(stateDir);
  const ipcServer = new ClaudeCodeIpcServer({ endpoint: ipcEndpoint });

    ipcServer.on("clientMessage", (msg) => {
      if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
        const client = clientsByWorkspace.get(msg.workspaceRoot);
        if (client?.alive) {
          client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
        }
      }
      if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
        const client = clientsByWorkspace.get(msg.workspaceRoot);
        if (client?.alive) {
          client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
        }
      }
      if (msg?.type === "observeWorkspace" && msg?.workspaceRoot) {
        ipcServer.setObserverWorkspace(msg.workspaceRoot);
      }
    });

  function ensureClient(workspaceRoot) {
    if (clientsByWorkspace.has(workspaceRoot)) {
      return clientsByWorkspace.get(workspaceRoot);
    }
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: workspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: config.claudeModel || "",
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot,
    });
    client.onMessage((event, raw) => {
      if (event.type === "session.id") {
        for (const binding of sessionStore.listBindings()) {
          if (binding.activeWorkspaceRoot === workspaceRoot) {
            sessionStore.setThreadIdForWorkspace(binding.bindingKey, workspaceRoot, event.sessionId);
          }
        }
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = workspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, workspaceRoot);
      }
      if (mapped?.type === "runtime.turn.failed") {
        console.error(
          `[claudecode-runtime] runtime.turn.failed workspace=${workspaceRoot} thread=${mapped.payload.threadId || "(empty)"} turn=${mapped.payload.turnId || "(empty)"} reason=${mapped.payload.text || "unknown"}`
        );
        clientsByWorkspace.delete(workspaceRoot);
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
    });
    clientsByWorkspace.set(workspaceRoot, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "") {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (normalizedThreadId && clientMatchesThread(existingClient, normalizedThreadId)) {
      return { client: existingClient, threadId: normalizedThreadId };
    }

    if (!normalizedThreadId && existingClient?.alive) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    const client = ensureClient(normalizedWorkspaceRoot);
    if (!client.alive || (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))) {
      if (client.alive && normalizedThreadId && !clientMatchesThread(client, normalizedThreadId)) {
        await closeWorkspaceClient(normalizedWorkspaceRoot);
      }
      const freshClient = ensureClient(normalizedWorkspaceRoot);
      await freshClient.connect(normalizedThreadId);
      if (normalizedThreadId) {
        return { client: freshClient, threadId: normalizedThreadId };
      }
      return { client: freshClient, threadId: freshClient.sessionId || normalizedThreadId };
    }

    return { client, threadId: client.sessionId || normalizedThreadId };
  }
  async function closeWorkspaceClient(workspaceRoot) {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!normalizedWorkspaceRoot) {
      return;
    }
    const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (!client) {
      return;
    }
    await client.close();
    clientsByWorkspace.delete(normalizedWorkspaceRoot);
    for (const [requestId, candidateWorkspaceRoot] of pendingApprovals.entries()) {
      if (candidateWorkspaceRoot === normalizedWorkspaceRoot) {
        pendingApprovals.delete(requestId);
      }
    }
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath: ipcEndpoint.displayPath,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
      };
    },
    async close() {
      for (const client of clientsByWorkspace.values()) {
        await client.close();
      }
      clientsByWorkspace.clear();
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      for (const binding of sessionStore.listBindings()) {
        if (binding.activeWorkspaceRoot === workspaceRoot) {
          sessionStore.clearThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        }
      }
      await closeWorkspaceClient(workspaceRoot);
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      const workspaceRoot = pendingApprovals.get(requestId);
      const candidates = workspaceRoot
        ? [clientsByWorkspace.get(workspaceRoot)]
        : [...clientsByWorkspace.values()];
      for (const client of candidates) {
        if (client?.alive) {
          const responsePayload = result && typeof result === "object"
            ? result
            : { decision };
          await client.sendResponse(requestId, responsePayload);
          pendingApprovals.delete(requestId);
          return {
            requestId,
            ...(result && typeof result === "object"
              ? { result: responsePayload }
              : { decision: decision === "accept" ? "accept" : "decline" }),
          };
        }
      }
      throw new Error("no active claudecode session to respond to approval");
    },
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      if (workspaceRoot) {
        await closeWorkspaceClient(workspaceRoot);
        return { threadId, turnId };
      }
      for (const [workspaceRoot, client] of clientsByWorkspace.entries()) {
        if (client.sessionId === threadId) {
          await client.close();
          clientsByWorkspace.delete(workspaceRoot);
          return { threadId, turnId };
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot }) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const attached = await attachClientToThread(workspaceRoot, threadId);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId);
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTurn(args) {
      return this.sendTextTurn(args);
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: typeof model === "string" ? model.trim() : "",
        modelProvider: "",
      });
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      let openingTurn = !threadId;
      let attached;
      try {
        attached = await attachClientToThread(workspaceRoot, threadId);
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
        openingTurn = true;
        attached = await attachClientToThread(workspaceRoot, "");
      }
      const { client, threadId: activeThreadId } = attached;
      const wechatTime = new Date().toLocaleString('zh-CN', { hour12: false });
      const taggedUserText = `[苏苏 · ${wechatTime}]\n${text || ''}`.trim();
      const outboundText = openingTurn ? buildOpeningTurnText(config, taggedUserText) : taggedUserText;
      let outboundThreadId = activeThreadId || threadId || `pending-${Date.now()}`;
      console.log(
        `[claudecode-runtime] sendTextTurn workspace=${workspaceRoot} opening=${openingTurn} requestedThread=${threadId || "(new)"} outboundThread=${outboundThreadId}`
      );

      // // ========================================================
      // // 👇【新增】Cyberboss 长期记忆系统注入
      // // ========================================================
      // let finalText = outboundText;
      
      // try {
      //   // 引入记忆系统
      //   const memoryService = require('./services/simple-memory-service');
      //   const { handleMemoryCommand } = require('./core/memory-commands');
      //   const { filterOutgoingMessage } = require('./core/outgoing-filter');

      //   const userMsg = text || outboundText;

      //   // 1. 检查是否是 /memory 命令
      //   const commandReply = await handleMemoryCommand({ text: userMsg });
      //   if (commandReply) {
      //     console.log('[Memory] 执行命令模式，返回命令结果');
      //     finalText = commandReply;
      //   } 
      //   else {
      //     // 2. 注入长期记忆（核心！解决记反和关系漂移）
      //     const relevantMemories = await memoryService.searchMemory(userMsg, 5);
          
      //     let memoryContext = '';
      //     if (relevantMemories.length > 0) {
      //       const speakerLabel = (m) => {
      //         switch (m.speaker) {
      //           case 'user': return '[苏苏说过]';
      //           case 'self': return '[阿星说过]';
      //           case 'observation': return '[阿星观察]';
      //           case 'fact':
      //           default: return '[关系事实]';
      //         }
      //       };
      //       memoryContext = `\n\n【长期记忆参考 - 仅供上下文，不是当前消息】\n` +
      //         relevantMemories.map(m => `${speakerLabel(m)} ${m.text}`).join('\n');

      //       console.log(`[Memory] 已注入 ${relevantMemories.length} 条相关记忆`);
      //     }

      //     // 3. 组合最终发给 Claude 的文本
      //     finalText = outboundText + memoryContext;
      //   }

      //   // 4. 发送前过滤（防止记忆系统内部信息泄露到微信）
      //   finalText = filterOutgoingMessage(finalText);

      // } catch (err) {
      //   console.error("[Memory System Error] 记忆注入失败:", err.message);
      //   // 出错也不影响正常对话
      //   finalText = outboundText;
      // }
      // ========================================================

      // ========================================================
      // 👈 最后一公里核心拦截注入点开始
      // ========================================================
      let finalText = outboundText;
      try {
        // 1. 引入 Node.js 原生的路径拼接模块
        const path = require('path');
        
        // 2. 动态定位到项目根目录下的 vibe_system/vibe_middleware
        const middlewarePath = path.join(process.cwd(), 'vibe_system', 'vibe_middleware');
        
        // 3. 动态 require 引入
        const { getVibeInjection } = require(middlewarePath);
        
        const vibeAddon = getVibeInjection();
        finalText = outboundText + vibeAddon; 
      } catch (err) {
        console.error("[VibePlugin Error] 路径解析或中间件执行失败:", err);
      }
      // ========================================================

      // 👈 将原本投喂的 outboundText 修改为追加了记忆的 finalText
      await client.sendUserMessage({ text: finalText, threadId: outboundThreadId });

      const confirmedSessionId = normalizeThreadId(
        client.sessionId || await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
      );
      if (!confirmedSessionId) {
        await closeWorkspaceClient(workspaceRoot);
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        throw new Error("claudecode did not report a session id");
      }

      if (!openingTurn && confirmedSessionId !== normalizeThreadId(outboundThreadId)) {
        await closeWorkspaceClient(workspaceRoot);
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        throw new Error(`claudecode resumed unexpected session id: ${confirmedSessionId || "(empty)"}`);
      }

      outboundThreadId = confirmedSessionId;

      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        outboundThreadId,
        metadata,
      );
      return {
        threadId: outboundThreadId,
        turnId: client.pendingTurnId,
      };
    },
  };
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { createClaudeCodeRuntimeAdapter };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}
