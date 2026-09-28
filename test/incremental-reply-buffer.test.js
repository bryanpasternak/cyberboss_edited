const test = require("node:test");
const assert = require("node:assert/strict");

const {
  IncrementalReplyBuffer,
  appendStreamingText,
  looksLikeStructuredReplyStart,
} = require("../src/core/incremental-reply-buffer");

test("appendStreamingText accepts token, cumulative, repeated, and overlapping deltas", () => {
  assert.equal(appendStreamingText("你好", "呀"), "你好呀");
  assert.equal(appendStreamingText("你好", "你好呀"), "你好呀");
  assert.equal(appendStreamingText("你好呀", "好呀"), "你好呀");
  assert.equal(appendStreamingText("abcdef", "defghi"), "abcdefghi");
});

test("incremental buffer waits below its target and seals at a natural boundary", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 24, hardMaxBytes: 30, carryBytes: 3 });
  buffer.append("第一句。第二句。尾巴");
  const ready = buffer.peekReadyChunk();
  assert.ok(ready);
  assert.equal(ready.rawText, "第一句。第二句。");
  assert.equal(buffer.commit(ready.token), true);
  assert.equal(buffer.peekReadyChunk(), null);
  assert.deepEqual(buffer.finalize("第一句。第二句。尾巴"), {
    text: "尾巴",
    mismatch: false,
    hadEarlyCommit: true,
    committedRawLength: "第一句。第二句。".length,
  });
});

test("incremental buffer hard-splits UTF-8 safely when no boundary appears", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 9, hardMaxBytes: 12, carryBytes: 0 });
  buffer.append("你你你你你");
  const ready = buffer.peekReadyChunk();
  assert.ok(ready);
  assert.equal(ready.rawText, "你你你你");
  assert.equal(Buffer.byteLength(ready.rawText, "utf8"), 12);
});

test("incremental buffer keeps emoji whole at a hard boundary", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 5, hardMaxBytes: 8, carryBytes: 0 });
  buffer.append("🌙🌙🌙");
  const ready = buffer.peekReadyChunk();
  assert.ok(ready);
  assert.equal(ready.rawText, "🌙🌙");
  assert.equal(Buffer.byteLength(ready.rawText, "utf8"), 8);
});

test("incremental buffer does not advance until a pending chunk is committed", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 8, hardMaxBytes: 12, carryBytes: 0 });
  buffer.append("一段正文。继续");
  const first = buffer.peekReadyChunk();
  assert.ok(first);
  assert.deepEqual(buffer.peekReadyChunk(), first);
  assert.equal(buffer.reject(first.token), true);
  const retried = buffer.peekReadyChunk();
  assert.equal(retried.rawText, first.rawText);
  assert.equal(buffer.commit("wrong-token"), false);
  assert.equal(buffer.commit(retried.token), true);
});

test("final text replaces only the unsent tail when committed prefix is stable", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 8, hardMaxBytes: 12, carryBytes: 0 });
  buffer.append("第一段。旧尾巴");
  const ready = buffer.peekReadyChunk();
  buffer.commit(ready.token);
  const committed = ready.rawText;
  assert.deepEqual(buffer.finalize(`${committed}新尾巴`), {
    text: "新尾巴",
    mismatch: false,
    hadEarlyCommit: true,
    committedRawLength: committed.length,
  });
});

test("stream transcript remains authoritative after final text rewrites a committed prefix", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 8, hardMaxBytes: 12, carryBytes: 0 });
  buffer.append("第一段。流式尾巴");
  const ready = buffer.peekReadyChunk();
  buffer.commit(ready.token);
  assert.deepEqual(buffer.finalize("完全改写的完成稿"), {
    text: "流式尾巴",
    mismatch: true,
    hadEarlyCommit: true,
    committedRawLength: ready.rawText.length,
  });
});

test("without an early commit the final text remains authoritative", () => {
  const buffer = new IncrementalReplyBuffer({ targetBytes: 100, hardMaxBytes: 120, carryBytes: 0 });
  buffer.append("草稿");
  assert.deepEqual(buffer.finalize("完成稿"), {
    text: "完成稿",
    mismatch: false,
    hadEarlyCommit: false,
    committedRawLength: 0,
  });
});

test("structured replies and unsafe tails are withheld from early delivery", () => {
  assert.equal(looksLikeStructuredReplyStart('{"action":"send_message"}'), true);
  assert.equal(looksLikeStructuredReplyStart("json: {\"action\":\"silent\"}"), true);
  assert.equal(looksLikeStructuredReplyStart("普通正文"), false);

  const structured = new IncrementalReplyBuffer({ targetBytes: 8, hardMaxBytes: 12, carryBytes: 0 });
  structured.append('{"action":"send_message","message":"秘密"}');
  assert.equal(structured.peekReadyChunk(), null);

  const keyboard = new IncrementalReplyBuffer({ targetBytes: 8, hardMaxBytes: 12, carryBytes: 0 });
  keyboard.append('一段足够长的正文。<!--telegram-inline-keyboard:[{"text":"继续"}]-->');
  const ready = keyboard.peekReadyChunk();
  assert.ok(ready);
  assert.doesNotMatch(ready.rawText, /telegram-inline-keyboard/);
});
