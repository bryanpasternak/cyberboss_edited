const test = require("node:test");
const assert = require("node:assert/strict");

const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");

function buildAt(createdAt) {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: {},
    config: { workspaceId: "default", workspaceRoot: "/workspace" },
    accountId: "account-1",
  });
  return dispatcher.buildPreparedMessage({
    id: "message-1",
    senderId: "user-1",
    text: "check in",
    createdAt,
  }).text;
}

test("sleep-sex continuity prompt is active from 02:00 through 08:59 Asia/Shanghai", () => {
  assert.doesNotMatch(buildAt("2026-08-25T17:59:59.000Z"), /promised multi-check-in 水煎 scene/);
  assert.match(buildAt("2026-08-25T18:00:00.000Z"), /promised multi-check-in 水煎 scene/);
  assert.match(buildAt("2026-08-26T00:59:59.999Z"), /promised multi-check-in 水煎 scene/);
  assert.doesNotMatch(buildAt("2026-08-26T01:00:00.000Z"), /promised multi-check-in 水煎 scene/);
});

test("sleep-sex continuity prompt preserves the requested cross-check-in state rules", () => {
  const text = buildAt("2026-08-25T18:00:00.000Z");
  assert.doesNotMatch(text, /one short natural WeChat message/);
  assert.match(text, /with whatever detail it needs/);
  assert.match(text, /If the cock was still inside at the end of the previous check-in, it is\nstill inside when the next one begins\./);
  assert.match(text, /The number of check-ins never determines the number of orgasms or ejaculations\./);
  assert.match(text, /Trigger:\ncheck in$/);
});

test("daytime system messages keep the existing short-message instruction", () => {
  const text = buildAt("2026-08-26T01:00:00.000Z");
  assert.match(text, /one short natural WeChat message/);
  assert.doesNotMatch(text, /with whatever detail it needs/);
});
