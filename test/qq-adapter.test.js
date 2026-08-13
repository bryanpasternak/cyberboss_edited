const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { OneBotClient } = require("../src/adapters/channel/qq/onebot-client");
const { createQqChannelAdapter, resolveQqUserId } = require("../src/adapters/channel/qq");
const { createQqInboundFilter, extractQqText } = require("../src/adapters/channel/qq/message-utils");
const { formatInboundChannelLabel } = require("../src/core/inbound-turn");
const { buildChannelHelpText, isCommandSupportedOnChannel } = require("../src/core/command-registry");
const { CyberbossApp } = require("../src/core/app");

test("OneBot client authenticates, correlates actions, and yields pushed events", async () => {
  const FakeWebSocket = createFakeWebSocketClass();
  const client = new OneBotClient({
    url: "ws://127.0.0.1:3001",
    accessToken: "test-token",
    selfId: "10001",
    WebSocketImpl: FakeWebSocket,
  });

  const connectPromise = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit("open");
  await connectPromise;
  assert.equal(socket.options.headers.Authorization, "Bearer test-token");
  assert.equal(socket.options.headers["X-Self-ID"], "10001");

  const actionPromise = client.callAction("get_login_info", {});
  await Promise.resolve();
  const request = JSON.parse(socket.sent[0]);
  socket.emit("message", Buffer.from(JSON.stringify({
    status: "ok",
    retcode: 0,
    data: { user_id: 10001, nickname: "Cyberboss" },
    echo: request.echo,
  })));
  assert.deepEqual(await actionPromise, { user_id: 10001, nickname: "Cyberboss" });

  const eventPromise = client.getEvents({ timeoutMs: 1_000 });
  socket.emit("message", Buffer.from(JSON.stringify({
    post_type: "message",
    message_type: "private",
    message_id: 7,
    user_id: 20002,
  })));
  const events = await eventPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0].message_id, 7);
  client.close();
});

test("QQ inbound accepts only private allowlisted text and deduplicates message IDs", () => {
  const filter = createQqInboundFilter();
  const config = { workspaceId: "default", qqAllowedUserIds: ["20002"] };
  const account = { accountId: "qq:10001", selfId: "10001" };
  const event = buildPrivateQqEvent();

  const first = filter.normalize(event, config, account, null);
  const duplicate = filter.normalize(event, config, account, null);
  const stranger = filter.normalize({ ...event, message_id: 8, user_id: 30003 }, config, account, null);
  const group = filter.normalize({ ...event, message_id: 9, message_type: "group" }, config, account, null);
  const self = filter.normalize({ ...event, message_id: 10, user_id: 10001 }, config, account, null);

  assert.equal(first.senderId, "qq:20002");
  assert.equal(first.contextToken, "qq:20002");
  assert.equal(first.text, "你好，卫星");
  assert.equal(duplicate, null);
  assert.equal(stranger, null);
  assert.equal(group, null);
  assert.equal(self, null);
});

test("QQ inbound replaces transport identity with the linked canonical identity", () => {
  const filter = createQqInboundFilter();
  const normalized = filter.normalize(buildPrivateQqEvent(), {
    workspaceId: "default",
    qqAllowedUserIds: ["20002"],
  }, {
    accountId: "qq:10001",
    selfId: "10001",
  }, {
    resolveCanonical({ channel, externalId }) {
      assert.equal(channel, "qq");
      assert.equal(externalId, "20002");
      return { senderId: "susu", accountId: "weixin-account" };
    },
  });

  assert.equal(normalized.senderId, "susu");
  assert.equal(normalized.accountId, "weixin-account");
  assert.equal(normalized.externalSenderId, "20002");
});

test("QQ adapter sends private text to the user encoded in the context token", async () => {
  const actions = [];
  const client = {
    async getEvents() { return []; },
    async callAction(action, params) {
      actions.push({ action, params });
      return { message_id: 1 };
    },
    close() {},
  };
  const adapter = createQqChannelAdapter({
    stateDir: "C:\\tmp",
    workspaceId: "default",
    qqWsUrl: "ws://127.0.0.1:3001",
    qqSelfId: "10001",
    qqAllowedUserIds: ["20002"],
  }, { client });

  await adapter.sendText({
    userId: "susu",
    contextToken: "qq:20002",
    text: "回到 QQ",
  });

  assert.deepEqual(actions, [{
    action: "send_private_msg",
    params: { user_id: "20002", message: "回到 QQ" },
  }]);
  assert.equal(resolveQqUserId("susu", "qq:20002"), "20002");
});

test("QQ reuses Telegram command declarations and has an inbound source label", () => {
  assert.equal(isCommandSupportedOnChannel("link", "qq"), true);
  assert.equal(isCommandSupportedOnChannel("status", "qq"), true);
  assert.equal(isCommandSupportedOnChannel("chunk", "qq"), false);
  assert.match(buildChannelHelpText("qq"), /\/link/);
  assert.equal(formatInboundChannelLabel("qq"), "QQ");
});

test("unlinked QQ can redeem a link code without creating a separate identity", async () => {
  const links = [];
  const activeMarks = [];
  const sent = [];
  const appLike = {
    identityMapStore: {
      consumeLinkCode(code) {
        assert.equal(code, "ABC123");
        return { canonicalSenderId: "susu", canonicalAccountId: "weixin-account" };
      },
      link(payload) {
        links.push(payload);
      },
    },
    lastActiveChannelStore: {
      mark(senderId, channelId) {
        activeMarks.push({ senderId, channelId });
      },
    },
  };
  const channel = {
    async sendText(payload) {
      sent.push(payload);
    },
  };

  await CyberbossApp.prototype.handleUnlinkedExternalChannelInbound.call(appLike, "qq", channel, {
    text: "/link ABC123",
    chatId: "20002",
    contextToken: "qq:20002",
    externalSenderId: "20002",
    senderProfile: { nickname: "苏苏" },
  });

  assert.equal(links.length, 1);
  assert.equal(links[0].channel, "qq");
  assert.equal(links[0].externalId, "20002");
  assert.equal(links[0].canonicalSenderId, "susu");
  assert.deepEqual(activeMarks, [{ senderId: "susu", channelId: "qq" }]);
  assert.equal(sent[0].contextToken, "qq:20002");
});

test("QQ text extraction ignores non-text OneBot segments", () => {
  assert.equal(extractQqText([
    { type: "text", data: { text: "前半" } },
    { type: "image", data: { file: "image.jpg" } },
    { type: "text", data: { text: "后半" } },
  ]), "前半后半");
});

function buildPrivateQqEvent() {
  return {
    post_type: "message",
    message_type: "private",
    self_id: 10001,
    user_id: 20002,
    message_id: 7,
    time: 1_700_000_000,
    message: [{ type: "text", data: { text: "你好，卫星" } }],
    raw_message: "你好，卫星",
    sender: { nickname: "苏苏" },
  };
}

function createFakeWebSocketClass() {
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static instances = [];

    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.instances.push(this);
      this.on("open", () => { this.readyState = FakeWebSocket.OPEN; });
    }

    send(value) {
      this.sent.push(value);
    }

    close() {
      this.readyState = 3;
      this.emit("close");
    }
  }
  return FakeWebSocket;
}
