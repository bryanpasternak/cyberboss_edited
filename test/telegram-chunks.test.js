const test = require("node:test");
const assert = require("node:assert/strict");

const {
  chunkReplyTextForTelegram,
  mergeTelegramShortChunks,
  splitForTelegram,
} = require("../src/adapters/channel/telegram");

test("chunkReplyTextForTelegram merges short natural boundaries", () => {
  const chunks = chunkReplyTextForTelegram("A。\n\nB。\n\nC。");
  assert.deepEqual(chunks, ["A。\n\nB。\n\nC。"]);
});

test("chunkReplyTextForTelegram keeps longer natural chunks separate", () => {
  const longA = "A".repeat(25) + "。";
  const longB = "B".repeat(25) + "。";
  const chunks = chunkReplyTextForTelegram(`${longA}\n\n${longB}`, 20);
  assert.deepEqual(chunks, [`${longA}\n\n`, longB]);
});

test("chunkReplyTextForTelegram hard-splits oversized utf8 chunks by Telegram byte limit", () => {
  const text = "你".repeat(1500);
  const chunks = chunkReplyTextForTelegram(text, 20);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 4096));
  assert.equal(chunks.join(""), text);
});

test("mergeTelegramShortChunks respects Telegram byte limit", () => {
  const chunks = ["你".repeat(1000), "好".repeat(1000), "呀"];
  const merged = mergeTelegramShortChunks(chunks, 4096, 2000);
  assert.ok(merged.length >= 2);
  assert.ok(merged.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 4096));
  assert.equal(merged.join(""), chunks.join(""));
});

test("splitForTelegram preserves text while splitting by utf8 bytes", () => {
  const text = "a".repeat(4095) + "你";
  const chunks = splitForTelegram(text, 4096);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(""), text);
});
