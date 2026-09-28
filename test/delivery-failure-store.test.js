const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DeliveryFailureStore } = require("../src/core/delivery-failure-store");

test("delivery failure store persists, deduplicates, and marks notifications", (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-delivery-failure-"));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const filePath = path.join(temporaryDirectory, "delivery-failures.json");
  const store = new DeliveryFailureStore({ filePath });
  const input = {
    channelId: "telegram",
    userId: "10001",
    contextToken: "tg:10001",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "generated reply",
    failedAt: "2026-09-01T00:00:00.000Z",
    lastError: "This operation was aborted",
  };

  const first = store.enqueue(input);
  const duplicate = store.enqueue(input);
  assert.equal(duplicate.id, first.id);
  assert.equal(store.pendingForChannel("telegram", 10).length, 1);

  const reloaded = new DeliveryFailureStore({ filePath });
  assert.equal(reloaded.pendingForChannel("telegram", 10)[0].text, "generated reply");
  assert.equal(reloaded.markNotified(first.id, "2026-09-01T00:01:00.000Z"), true);
  assert.deepEqual(reloaded.pendingForChannel("telegram", 10), []);
});
