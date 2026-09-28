const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("Telegram recovery sends a pending delivery notice and marks it delivered", async () => {
  const marked = [];
  const sent = [];
  const app = {
    deliveryFailureQueue: {
      pendingForChannel() {
        return [{
          id: "failure-1",
          channelId: "telegram",
          userId: "10001",
          contextToken: "tg:10001",
          failedAt: "2026-09-01T00:00:00.000Z",
        }];
      },
      markNotified(id) {
        marked.push(id);
      },
    },
  };
  const channel = {
    async sendText(payload) {
      sent.push(payload);
    },
  };

  await CyberbossApp.prototype.flushDeliveryFailureNotices.call(app, "telegram", channel);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, "10001");
  assert.match(sent[0].text, /已经生成过一条回复/);
  assert.match(sent[0].text, /无法确认你是否收到/);
  assert.deepEqual(marked, ["failure-1"]);
});

test("a failed recovery notice stays pending without recursive recording", async () => {
  let marked = false;
  const app = {
    deliveryFailureQueue: {
      pendingForChannel() {
        return [{ id: "failure-2", userId: "10002", contextToken: "tg:10002" }];
      },
      markNotified() {
        marked = true;
      },
    },
  };
  const channel = {
    async sendText() {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    },
  };

  await CyberbossApp.prototype.flushDeliveryFailureNotices.call(app, "telegram", channel);
  assert.equal(marked, false);
});
