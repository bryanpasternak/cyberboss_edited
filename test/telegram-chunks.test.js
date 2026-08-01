const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCallbackInboundUpdate,
  buildTelegramReplyMarkup,
  chunkReplyTextForTelegram,
  createTelegramChannelAdapter,
  extractTelegramInlineKeyboard,
  findCallbackButton,
  findCallbackButtonText,
  mergeTelegramShortChunks,
  splitForTelegram,
} = require("../src/adapters/channel/telegram");

test("extractTelegramInlineKeyboard removes a valid trailing directive", () => {
  const result = extractTelegramInlineKeyboard([
    "今晚选哪个？",
    '<!--telegram-inline-keyboard:[{"text":"抱抱","callback_data":"hug"},{"text":"亲亲","callback_data":"kiss"}]-->',
  ].join("\n"));
  assert.equal(result.text, "今晚选哪个？");
  assert.deepEqual(result.buttons, [
    { text: "抱抱", callback_data: "hug" },
    { text: "亲亲", callback_data: "kiss" },
  ]);
  assert.deepEqual(buildTelegramReplyMarkup(result.buttons), {
    inline_keyboard: [
      [{ text: "抱抱", callback_data: "hug" }],
      [{ text: "亲亲", callback_data: "kiss" }],
    ],
  });
});

test("extractTelegramInlineKeyboard only parses a directive at the end", () => {
  const source = [
    '<!--telegram-inline-keyboard:[{"text":"抱抱","callback_data":"hug"}]-->',
    "后面还有正文",
  ].join("\n");
  assert.deepEqual(extractTelegramInlineKeyboard(source), { text: source, buttons: [] });
});

test("extractTelegramInlineKeyboard strips malformed trailing JSON without producing buttons", () => {
  const result = extractTelegramInlineKeyboard("请选择\n<!--telegram-inline-keyboard:[oops]-->");
  assert.deepEqual(result, { text: "请选择", buttons: [] });
});

test("callback query resolves button text and becomes a synthetic inbound message", () => {
  const update = {
    update_id: 42,
    callback_query: {
      id: "callback-1",
      data: "kiss",
      from: { id: 7, first_name: "苏苏" },
      message: {
        message_id: 99,
        chat: { id: 123, type: "private" },
        reply_markup: {
          inline_keyboard: [
            [{ text: "抱抱", callback_data: "hug" }],
            [{ text: "直接亲我", callback_data: "kiss" }],
          ],
        },
      },
    },
  };
  const text = findCallbackButtonText(update.callback_query);
  assert.equal(text, "直接亲我");
  assert.deepEqual(findCallbackButton(update.callback_query), {
    text: "直接亲我",
    callback_data: "kiss",
  });
  const inbound = buildCallbackInboundUpdate(update, text);
  assert.equal(inbound.update_id, 42);
  assert.equal(inbound.message.message_id, 99);
  assert.equal(inbound.message.chat.id, 123);
  assert.equal(inbound.message.from.id, 7);
  assert.equal(inbound.message.text, "直接亲我");
});

test("telegram adapter sends buttons on the final chunk", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tg-buttons-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  disableTelegramProxyForTest(t);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = createTelegramChannelAdapter(buildTelegramTestConfig(tempDir));
  await adapter.sendText({
    userId: "123",
    text: '选一个\n<!--telegram-inline-keyboard:[{"text":"抱抱","callback_data":"hug"}]-->',
    contextToken: "tg:123",
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/sendMessage$/);
  assert.equal(requests[0].body.text, "选一个");
  assert.deepEqual(requests[0].body.reply_markup, {
    inline_keyboard: [[{ text: "抱抱", callback_data: "hug" }]],
  });
});

test("telegram adapter acknowledges a callback, removes buttons, and injects its label", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tg-callback-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  disableTelegramProxyForTest(t);
  const methods = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop();
    methods.push(method);
    const result = method === "getUpdates"
      ? [{
          update_id: 8,
          callback_query: {
            id: "callback-8",
            data: "kiss",
            from: { id: 7, first_name: "苏苏" },
            message: {
              message_id: 9,
              chat: { id: 123, type: "private" },
              reply_markup: {
                inline_keyboard: [[{ text: "直接亲我", callback_data: "kiss" }]],
              },
            },
          },
        }]
      : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const identityMapStore = {
    resolveCanonical() {
      return { senderId: "susu", accountId: "wechat-account" };
    },
  };
  const config = buildTelegramTestConfig(tempDir);
  config.telegramAllowedChatIds = ["susu"];
  const adapter = createTelegramChannelAdapter(config, { identityMapStore });
  const response = await adapter.getUpdates({ timeoutMs: 1_000 });

  assert.deepEqual(methods, ["getUpdates", "answerCallbackQuery", "editMessageReplyMarkup"]);
  assert.equal(response.msgs.length, 1);
  const normalized = adapter.normalizeIncomingMessage(response.msgs[0]);
  assert.equal(normalized.senderId, "susu");
  assert.equal(normalized.contextToken, "tg:123");
  assert.equal(normalized.text, "直接亲我");
});

test("telegram adapter opens a ForceReply prompt for an input callback", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-tg-input-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  disableTelegramProxyForTest(t);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    const result = method === "getUpdates"
      ? [{
          update_id: 10,
          callback_query: {
            id: "callback-10",
            data: "input:说说你真正想要的玩法",
            from: { id: 7, first_name: "苏苏" },
            message: {
              message_id: 11,
              chat: { id: 123, type: "private" },
              reply_markup: {
                inline_keyboard: [[{
                  text: "其他（自己输入）",
                  callback_data: "input:说说你真正想要的玩法",
                }]],
              },
            },
          },
        }]
      : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const identityMapStore = {
    resolveCanonical() {
      return { senderId: "susu", accountId: "wechat-account" };
    },
  };
  const config = buildTelegramTestConfig(tempDir);
  config.telegramAllowedChatIds = ["susu"];
  const adapter = createTelegramChannelAdapter(config, { identityMapStore });
  const response = await adapter.getUpdates({ timeoutMs: 1_000 });

  assert.deepEqual(requests.map((item) => item.method), [
    "getUpdates",
    "answerCallbackQuery",
    "editMessageReplyMarkup",
    "sendMessage",
  ]);
  assert.deepEqual(response.msgs, []);
  const prompt = requests[3].body;
  assert.equal(prompt.text, "好，直接输入你的选择：");
  assert.deepEqual(prompt.reply_markup, {
    force_reply: true,
    selective: true,
    input_field_placeholder: "说说你真正想要的玩法",
  });
});

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

function buildTelegramTestConfig(tempDir) {
  return {
    stateDir: tempDir,
    accountsDir: tempDir,
    workspaceId: "test-workspace",
    telegramApiBaseUrl: "https://api.telegram.test",
    telegramBotToken: "test-token",
    telegramAllowedChatIds: ["123"],
    telegramOffsetFile: path.join(tempDir, "telegram-offset.json"),
    telegramConfigFile: path.join(tempDir, "telegram-config.json"),
    telegramMinChunkChars: 20,
    telegramShowThinking: true,
  };
}

function disableTelegramProxyForTest(t) {
  const keys = [
    "CYBERBOSS_TELEGRAM_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}
