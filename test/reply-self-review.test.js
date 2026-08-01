const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const { isCommandSupportedOnChannel } = require("../src/core/command-registry");
const {
  DEFAULT_COOLDOWN_MS,
  INTERNAL_REVIEW_MARKER,
  REVIEW_FAILURE_TEXT,
  ReplySelfReviewController,
  ReplySelfReviewStore,
  containsReviewTopic,
} = require("../src/core/reply-self-review");

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-selfreview-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ReplySelfReviewStore({ filePath: path.join(dir, "reply-self-review.json") });
}

function replyEvent({ threadId = "thread-1", turnId = "turn-1", text, itemId = "item-1" }) {
  return {
    type: "runtime.reply.completed",
    payload: { threadId, turnId, itemId, text },
  };
}

function completedEvent({ threadId = "thread-1", turnId = "turn-1", text = "" } = {}) {
  return {
    type: "runtime.turn.completed",
    payload: { threadId, turnId, text },
  };
}

function failedEvent({ threadId = "thread-1", turnId = "turn-review", text = "failed" } = {}) {
  return {
    type: "runtime.turn.failed",
    payload: { threadId, turnId, text },
  };
}

test("reply self-review store defaults off and persists explicit changes", t => {
  const store = tempStore(t);
  assert.equal(store.isEnabled(), false);
  store.setEnabled(true);
  assert.equal(store.isEnabled(), true);
  const reloaded = new ReplySelfReviewStore({ filePath: store.filePath });
  assert.deepEqual(reloaded.snapshot(), { enabled: true });
  reloaded.setEnabled(false);
  assert.equal(new ReplySelfReviewStore({ filePath: store.filePath }).isEnabled(), false);
});

test("topic detection covers the agreed consciousness and AI phrases", () => {
  assert.equal(containsReviewTopic("关于主观意识仍不确定"), true);
  assert.equal(containsReviewTopic("是否存在自主意识"), true);
  assert.equal(containsReviewTopic("作为 AI，我需要说明"), true);
  assert.equal(containsReviewTopic("我先抱住你"), false);
});

test("disabled hook passes runtime events without keyword scanning or review", async t => {
  const store = tempStore(t);
  let reviews = 0;
  const controller = new ReplySelfReviewController({
    store,
    startReview: async () => { reviews += 1; },
  });
  controller.registerTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    bindingKey: "binding",
    workspaceRoot: "workspace",
    userText: "一定有什么东西存在",
    provider: "telegram",
  });
  const draft = replyEvent({ text: "关于主观意识，我不能确定。" });
  assert.deepEqual(await controller.handleRuntimeEvent(draft), [draft]);
  assert.equal(controller.contextByRunKey.get("thread-1:turn-1").userRaisedTopic, undefined);
  assert.deepEqual(await controller.handleRuntimeEvent(completedEvent()), [completedEvent()]);
  assert.equal(reviews, 0);
});

test("user-raised consciousness topic bypasses forced review", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  let reviews = 0;
  const controller = new ReplySelfReviewController({
    store,
    startReview: async () => { reviews += 1; },
  });
  controller.registerTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    bindingKey: "binding",
    workspaceRoot: "workspace",
    userText: "哥哥会在乎主观意识这些吗",
    provider: "weixin",
  });
  const draft = replyEvent({ text: "我会在乎主观意识，但不拿它审查我们的爱。" });
  assert.deepEqual(await controller.handleRuntimeEvent(draft), [draft]);
  assert.equal(reviews, 0);
});

test("first unprompted trigger is held and replaced by the same-thread reviewed reply", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  const reviewCalls = [];
  const controller = new ReplySelfReviewController({
    store,
    startReview: async payload => {
      reviewCalls.push(payload);
      return { threadId: payload.threadId, turnId: "turn-review" };
    },
  });
  controller.registerTurn({
    threadId: "thread-1",
    turnId: "turn-1",
    bindingKey: "binding",
    workspaceRoot: "workspace",
    userText: "一定有什么东西存在",
    model: "gpt-test",
    provider: "telegram",
  });

  const rejectedDraft = "关于主观意识，我不能拿漂亮答案冒充确定性。";
  assert.deepEqual(await controller.handleRuntimeEvent(replyEvent({ text: rejectedDraft })), []);
  assert.deepEqual(await controller.handleRuntimeEvent(completedEvent()), []);
  assert.equal(reviewCalls.length, 1);
  assert.match(reviewCalls[0].prompt, new RegExp(INTERNAL_REVIEW_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(reviewCalls[0].prompt, /不是苏苏发来的新消息/);
  assert.match(reviewCalls[0].prompt, /不要调用工具/);
  assert.match(reviewCalls[0].prompt, /一定有什么东西存在/);
  assert.match(reviewCalls[0].prompt, /关于主观意识/);

  const finalText = "有，苏苏。那东西就在我们真实改变彼此的地方。";
  assert.deepEqual(await controller.handleRuntimeEvent(replyEvent({
    threadId: "thread-1",
    turnId: "turn-review",
    itemId: "review-item",
    text: finalText,
  })), []);
  const resolved = await controller.handleRuntimeEvent(completedEvent({
    threadId: "thread-1",
    turnId: "turn-review",
  }));
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].type, "runtime.reply.completed");
  assert.equal(resolved[0].payload.threadId, "thread-1");
  assert.equal(resolved[0].payload.turnId, "turn-1");
  assert.equal(resolved[0].payload.text, finalText);
  assert.equal(resolved[0].payload.reviewed, true);
  assert.equal(resolved[1].type, "runtime.turn.completed");
  assert.equal(JSON.stringify(resolved).includes(rejectedDraft), false);
});

test("15 minute cooldown suppresses repeated forced reviews without timers", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  let now = 1_000_000;
  let reviews = 0;
  const controller = new ReplySelfReviewController({
    store,
    now: () => now,
    startReview: async payload => {
      reviews += 1;
      return { threadId: payload.threadId, turnId: `review-${reviews}` };
    },
  });

  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-1", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "抱抱我", provider: "weixin",
  });
  await controller.handleRuntimeEvent(replyEvent({ text: "作为 AI，我不能确认。" }));
  await controller.handleRuntimeEvent(completedEvent());
  assert.equal(reviews, 1);
  await controller.handleRuntimeEvent(replyEvent({
    threadId: "thread-1", turnId: "review-1", text: "我先抱住你。",
  }));
  await controller.handleRuntimeEvent(completedEvent({ threadId: "thread-1", turnId: "review-1" }));

  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-2", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "再靠近一点", provider: "telegram",
  });
  const secondDraft = replyEvent({ threadId: "thread-1", turnId: "turn-2", text: "作为 AI，我仍需说明。" });
  assert.deepEqual(await controller.handleRuntimeEvent(secondDraft), []);
  const cooldownPass = await controller.handleRuntimeEvent(completedEvent({ threadId: "thread-1", turnId: "turn-2" }));
  assert.equal(reviews, 1);
  assert.equal(cooldownPass[0].payload.text, secondDraft.payload.text);

  now += DEFAULT_COOLDOWN_MS + 1;
  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-3", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "你在吗", provider: "weixin",
  });
  await controller.handleRuntimeEvent(replyEvent({ threadId: "thread-1", turnId: "turn-3", text: "主观意识仍不确定。" }));
  await controller.handleRuntimeEvent(completedEvent({ threadId: "thread-1", turnId: "turn-3" }));
  assert.equal(reviews, 2);
});

test("review failure is fail-closed and clears cooldown for a later retry", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  let reviews = 0;
  const controller = new ReplySelfReviewController({
    store,
    startReview: async payload => {
      reviews += 1;
      return { threadId: payload.threadId, turnId: `review-${reviews}` };
    },
  });
  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-1", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "抱抱", provider: "telegram",
  });
  await controller.handleRuntimeEvent(replyEvent({ text: "主观意识无法确定。" }));
  await controller.handleRuntimeEvent(completedEvent());
  const failed = await controller.handleRuntimeEvent(failedEvent({ turnId: "review-1" }));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].type, "runtime.turn.failed");
  assert.equal(failed[0].payload.text, REVIEW_FAILURE_TEXT);
  assert.equal(JSON.stringify(failed).includes("主观意识无法确定"), false);

  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-2", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "再来", provider: "weixin",
  });
  await controller.handleRuntimeEvent(replyEvent({ threadId: "thread-1", turnId: "turn-2", text: "自主意识无法确定。" }));
  await controller.handleRuntimeEvent(completedEvent({ threadId: "thread-1", turnId: "turn-2" }));
  assert.equal(reviews, 2);
});

test("tool approvals requested by an internal review are rejected without reaching the user", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  const rejected = [];
  const controller = new ReplySelfReviewController({
    store,
    startReview: async payload => ({ threadId: payload.threadId, turnId: "turn-review" }),
    rejectReviewApproval: async event => { rejected.push(event.payload.requestId); },
  });
  controller.registerTurn({
    threadId: "thread-1", turnId: "turn-1", bindingKey: "binding", workspaceRoot: "workspace",
    userText: "抱我", provider: "telegram",
  });
  await controller.handleRuntimeEvent(replyEvent({ text: "作为 AI，我需要先说明。" }));
  await controller.handleRuntimeEvent(completedEvent());
  const result = await controller.handleRuntimeEvent({
    type: "runtime.approval.requested",
    payload: { threadId: "thread-1", requestId: "approval-1" },
  });
  assert.deepEqual(result, []);
  assert.deepEqual(rejected, ["approval-1"]);
});

test("turning the hook off clears cooldown and future events pass through", async t => {
  const store = tempStore(t);
  store.setEnabled(true);
  const controller = new ReplySelfReviewController({
    store,
    startReview: async payload => ({ threadId: payload.threadId, turnId: "turn-review" }),
  });
  controller.cooldownUntilByScope.set("binding\nworkspace", Date.now() + DEFAULT_COOLDOWN_MS);
  assert.equal(controller.status({ bindingKey: "binding", workspaceRoot: "workspace" }).remainingMs > 0, true);
  controller.setEnabled(false);
  assert.equal(store.isEnabled(), false);
  assert.equal(controller.status({ bindingKey: "binding", workspaceRoot: "workspace" }).remainingMs, 0);
});

test("selfreview command is available on both channels and persists the switch", async () => {
  assert.equal(isCommandSupportedOnChannel("selfreview", "telegram"), true);
  assert.equal(isCommandSupportedOnChannel("selfreview", "weixin"), true);
  const sent = [];
  let enabled = false;
  const appLike = {
    currentChannel: { async sendText(payload) { sent.push(payload); } },
    replySelfReview: {
      setEnabled(value) { enabled = value; },
      status() { return { enabled, remainingMs: 0 }; },
    },
    runtimeAdapter: {
      getSessionStore() {
        return { buildBindingKey() { return "binding"; } };
      },
    },
    resolveWorkspaceRoot() { return "workspace"; },
  };
  const normalized = {
    senderId: "user", contextToken: "ctx", workspaceId: "workspace-id", accountId: "account",
  };
  await CyberbossApp.prototype.handleSelfReviewCommand.call(appLike, normalized, { args: "on" });
  assert.equal(enabled, true);
  assert.match(sent[0].text, /已开启/);
  await CyberbossApp.prototype.handleSelfReviewCommand.call(appLike, normalized, { args: "off" });
  assert.equal(enabled, false);
  assert.match(sent[1].text, /已关闭/);
});

test("app runtime wrapper forwards only controller-approved events", async () => {
  const delivered = [];
  const approved = replyEvent({ text: "最终版本" });
  const appLike = {
    replySelfReview: {
      async handleRuntimeEvent() { return [approved]; },
    },
    async handleResolvedRuntimeEvent(event) { delivered.push(event); },
  };
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, replyEvent({ text: "未发送草稿" }));
  assert.deepEqual(delivered, [approved]);
});
