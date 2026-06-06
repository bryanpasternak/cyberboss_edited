const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

function createSnapshot({ enabled = false, action = "none", driveKey = "attachment", score = 0.5 } = {}) {
  const drive = {
    attachment: 0.5,
    curiosity: 0.35,
    reflection: 0.35,
    duty: 0.3,
    social: 0.3,
    fatigue: 0.2,
    libido: 0.25,
    stress: 0.2,
  };
  return {
    state: {
      drive,
      thoughts: [],
      drivenBehaviorEnabled: enabled,
    },
    drive,
    scores: {},
    intent: {
      wantAction: action,
      driveKey,
      reason: "我有点想靠近你，心里冒出一句话。",
      score,
      queryHint: "",
    },
    thoughts: [],
    thoughtCount: 0,
    drivenBehaviorEnabled: enabled,
  };
}

function createDesireService() {
  const calls = [];
  const service = {
    enabled: false,
    snapshot: createSnapshot(),
    calls,
    getSnapshot() {
      return this.snapshot;
    },
    toggleDriven(enabled) {
      this.enabled = Boolean(enabled);
      this.snapshot = createSnapshot({ enabled: this.enabled });
      calls.push(["toggle", this.enabled]);
    },
    tick() {
      calls.push(["tick"]);
    },
    feedThought(text, drive, kind, strength) {
      calls.push(["feed", text, drive, kind, strength]);
      this.snapshot = {
        ...this.snapshot,
        thoughts: [{ text, drive, kind, strength }],
        thoughtCount: 1,
        state: {
          ...this.snapshot.state,
          thoughts: [{ text, drive, kind, strength }],
        },
      };
    },
    satisfyAction(action) {
      calls.push(["satisfy", action]);
      this.snapshot = createSnapshot({ enabled: this.enabled, action });
    },
  };
  return service;
}

test("handleDesireCommand toggles desire-driven check-in context", async () => {
  const sent = [];
  const service = createDesireService();
  const appLike = {
    projectServices: { desire: service },
    currentChannel: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleDesireCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "on",
  });

  assert.deepEqual(service.calls, [["toggle", true]]);
  assert.match(sent[0].text, /driven: on/);
  assert.match(sent[0].text, /Desire-driven check-in context: on/);
});

test("handleDesireCommand feeds and satisfies thoughts from channel commands", async () => {
  const sent = [];
  const service = createDesireService();
  const appLike = {
    projectServices: { desire: service },
    currentChannel: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleDesireCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "feed curiosity fixation 想看看外面有什么新东西",
  });
  await CyberbossApp.prototype.handleDesireCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "satisfy web_search",
  });

  assert.deepEqual(service.calls[0], ["feed", "想看看外面有什么新东西", "curiosity", "fixation", 0.8]);
  assert.deepEqual(service.calls[1], ["satisfy", "web_search"]);
  assert.match(sent[0].text, /Thought fed/);
  assert.match(sent[1].text, /Satisfied action: web_search/);
});

test("dispatchPreparedTurn records desire action for system turns", async () => {
  const appLike = {
    channelAdapter: {
      async sendTyping() {},
      async sendText() {},
    },
    resolveChannelById() {
      return null;
    },
    resolveChannelForSender() {
      return this.channelAdapter;
    },
    turnGateStore: {
      begin() {
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
      describe() {
        return { id: "codex" };
      },
    },
    runtimeContextStore: {
      setActiveContext() {},
    },
    async buildRuntimeTurn() {
      return {
        text: "Desire context: curiosity(0.80) is currently pulling me toward action=web_search. 我想探索外面的世界。",
        attachments: [],
      };
    },
    streamDelivery: {
      bindReplyTargetForTurn() {},
      queueReplyTargetForThread() {},
    },
    pendingDesireActionByRunKey: new Map(),
  };

  const dispatched = await CyberbossApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      text: "system text",
    },
  });

  assert.equal(dispatched, true);
  assert.equal(appLike.pendingDesireActionByRunKey.get("thread-1:turn-1"), "web_search");
  assert.equal(appLike.pendingDesireActionByRunKey.get("thread-1:"), "web_search");
});

test("handleRuntimeEvent satisfies recorded desire actions on completed turns", async () => {
  const calls = [];
  const appLike = {
    pendingDesireActionByRunKey: new Map([
      ["thread-1:turn-1", "web_search"],
      ["thread-1:", "web_search"],
    ]),
    projectServices: {
      desire: {
        satisfyAction(action) {
          calls.push(action);
        },
      },
    },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
    takePendingDesireAction: CyberbossApp.prototype.takePendingDesireAction,
    satisfyDesireAction: CyberbossApp.prototype.satisfyDesireAction,
  };

  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["web_search"]);
  assert.equal(appLike.pendingDesireActionByRunKey.has("thread-1:turn-1"), false);
  assert.equal(appLike.pendingDesireActionByRunKey.has("thread-1:"), false);
});
