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
    args: "satisfy web_browse",
  });

  assert.deepEqual(service.calls[0], ["feed", "想看看外面有什么新东西", "curiosity", "fixation", 0.8]);
  assert.deepEqual(service.calls[1], ["satisfy", "web_browse"]);
  assert.match(sent[0].text, /Thought fed/);
  assert.match(sent[1].text, /Satisfied action: web_browse/);
});

test("system turns have no automatic desire satisfaction hook", () => {
  assert.equal(CyberbossApp.prototype.takePendingDesireAction, undefined);
  assert.equal(CyberbossApp.prototype.satisfyDesireAction, undefined);
});

test("/desire displays every thought with complete untruncated text", async () => {
  const sent = [];
  const service = createDesireService();
  const thoughts = Array.from({ length: 7 }, (_, index) => ({
    id: `thought-${index + 1}`,
    text: `第${index + 1}条完整念头：${"很长的身体感受和欲望内容".repeat(8)}`,
    drive: "libido",
    kind: index === 6 ? "fixation" : "flit",
    strength: 0.5 + (index * 0.01),
    status: index === 0 ? "resolved" : "pending",
    resolution: index === 0 ? "journaled" : "",
  }));
  service.snapshot = {
    ...service.snapshot,
    thoughts,
    thoughtCount: thoughts.length,
    state: { ...service.snapshot.state, thoughts },
  };
  const appLike = {
    projectServices: { desire: service },
    currentChannel: {
      async sendText(payload) { sent.push(payload); },
    },
  };

  await CyberbossApp.prototype.handleDesireCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, { args: "" });

  assert.match(sent[0].text, /thoughts: 7/);
  assert.match(sent[0].text, /\[7\] 第7条完整念头/);
  assert.match(sent[0].text, new RegExp(thoughts[6].text));
  assert.match(sent[0].text, /status: resolved \(journaled\)/);
});
