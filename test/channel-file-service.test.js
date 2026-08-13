const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ChannelFileService } = require("../src/services/channel-file-service");
const { ChannelDeliveryTargetResolver } = require("../src/services/channel-delivery-target-resolver");

test("channel file service sends through the exact Telegram turn target", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-channel-file-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "report.pdf");
  fs.writeFileSync(filePath, "pdf");
  const sent = [];
  const telegram = createChannel("telegram", sent);
  const weixin = createChannel("weixin", sent);
  const channels = new Map([["telegram", telegram], ["weixin", weixin]]);
  const resolver = new ChannelDeliveryTargetResolver({
    config: { defaultOutboundChannel: "weixin" },
    sessionStore: null,
    channels,
    lastActiveStore: { resolve: () => ({ channelId: "weixin" }) },
  });
  const service = new ChannelFileService({
    resolveTarget: (payload) => resolver.resolve(payload),
    resolveChannel: (channelId) => channels.get(channelId),
  });

  const result = await service.sendToCurrentChat({ filePath }, {
    provider: "telegram",
    channelId: "telegram",
    senderId: "susu",
    externalUserId: "12345",
    contextToken: "tg:12345",
  });

  assert.equal(result.channelId, "telegram");
  assert.equal(result.userId, "12345");
  assert.equal(sent.filter((item) => item.type === "file").length, 1);
  assert.equal(sent.find((item) => item.type === "file").channelId, "telegram");
});

test("channel file service preserves the exact Weixin reply context", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-channel-file-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, "image.png");
  fs.writeFileSync(filePath, "png");
  const sent = [];
  const channels = new Map([
    ["telegram", createChannel("telegram", sent)],
    ["weixin", createChannel("weixin", sent)],
  ]);
  const resolver = new ChannelDeliveryTargetResolver({ config: {}, channels });
  const service = new ChannelFileService({
    resolveTarget: (payload) => resolver.resolve(payload),
    resolveChannel: (channelId) => channels.get(channelId),
  });

  const result = await service.sendToCurrentChat({ filePath }, {
    provider: "weixin",
    senderId: "susu",
    contextToken: "wx-context-token",
  });

  assert.equal(result.channelId, "weixin");
  assert.equal(sent.find((item) => item.type === "file").contextToken, "wx-context-token");
});

test("delivery target resolution never falls across channels after a Telegram failure", () => {
  const channels = new Map([
    ["telegram", createChannel("telegram", [])],
    ["weixin", createChannel("weixin", [])],
  ]);
  const resolver = new ChannelDeliveryTargetResolver({
    config: { defaultOutboundChannel: "weixin" },
    channels,
    lastActiveStore: { resolve: () => ({ channelId: "weixin" }) },
  });
  assert.throws(() => resolver.resolve({
    context: { provider: "telegram", senderId: "susu", contextToken: "" },
  }), /Telegram chat/);
});

function createChannel(channelId, sent) {
  return {
    describe() { return { id: channelId }; },
    async sendTyping(payload) { sent.push({ type: "typing", channelId, ...payload }); },
    async sendFile(payload) {
      sent.push({ type: "file", channelId, ...payload });
      return { deliveryKind: channelId === "telegram" ? "document" : "file" };
    },
  };
}
