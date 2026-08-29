const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const { sendDocument } = require("../src/adapters/channel/telegram/api");

test("Telegram proxy upload sends a real multipart document body", async (t) => {
  const received = {};
  const target = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.url = request.url;
    received.contentType = request.headers["content-type"] || "";
    received.body = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: 42 } }));
  });
  await listen(target);

  const tunnels = new Set();
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    const [host, port] = String(request.url || "").split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    tunnels.add(clientSocket);
    tunnels.add(upstream);
    clientSocket.on("close", () => tunnels.delete(clientSocket));
    upstream.on("close", () => tunnels.delete(upstream));
  });
  await listen(proxy);

  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const apiBaseUrl = `http://127.0.0.1:${target.address().port}`;
  const proxyKeys = [
    "CYBERBOSS_TELEGRAM_PROXY",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
  ];
  const previous = new Map(proxyKeys.map((key) => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  process.env.CYBERBOSS_TELEGRAM_PROXY = proxyUrl;

  t.after(async () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const socket of tunnels) socket.destroy();
    await close(proxy);
    await close(target);
  });

  const result = await sendDocument({
    baseUrl: apiBaseUrl,
    botToken: "test-token",
    chatId: "12345",
    fileBuffer: Buffer.from("proxy-file-body"),
    fileName: "report.txt",
    caption: "proxy caption",
  });

  assert.equal(result.message_id, 42);
  assert.equal(received.url, "/bottest-token/sendDocument");
  assert.match(received.contentType, /^multipart\/form-data; boundary=/i);
  assert.match(received.body, /name="chat_id"\r\n\r\n12345/);
  assert.match(received.body, /name="caption"\r\n\r\nproxy caption/);
  assert.match(received.body, /name="document"; filename="report.txt"/);
  assert.match(received.body, /proxy-file-body/);
  assert.notEqual(received.body, "[object FormData]");
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
