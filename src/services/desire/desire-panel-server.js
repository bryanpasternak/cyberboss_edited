const fs = require("fs");
const http = require("http");
const path = require("path");

const { createDesireService } = require("../desire-service");

const PANEL_DIR = path.join(__dirname, "panel");
const MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function runDesirePanelServer({ config, service = null } = {}) {
  const desireService = service || createDesireService(config);
  const preferredHost = normalizeText(config?.desirePanelHost) || "127.0.0.1";
  const preferredPort = Number(config?.desirePanelPort) || 8765;
  const server = http.createServer((request, response) => {
    handleRequest({
      request,
      response,
      service: desireService,
    }).catch((error) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error || "unknown error"),
      });
    });
  });

  const bound = await listenOnAvailablePort(server, {
    host: preferredHost,
    port: preferredPort,
    attempts: 20,
  });
  console.log(`[cyberboss] desire panel ready at http://${bound.host}:${bound.port}`);
  return { server, service: desireService, url: `http://${bound.host}:${bound.port}` };
}

async function handleRequest({ request, response, service }) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/desire/state" && request.method === "GET") {
    sendJson(response, 200, service.getSnapshot());
    return;
  }
  if (url.pathname === "/api/desire/feed" && request.method === "POST") {
    const body = await readJsonBody(request);
    service.feedThought(body.text, body.drive, body.kind || "flit", body.strength ?? 0.5);
    sendJson(response, 200, service.getSnapshot());
    return;
  }
  if (url.pathname === "/api/desire/control" && request.method === "POST") {
    const body = await readJsonBody(request);
    service.toggleDriven(Boolean(body.enabled));
    sendJson(response, 200, service.getSnapshot());
    return;
  }
  if (url.pathname === "/api/desire/tick" && request.method === "POST") {
    service.tick();
    sendJson(response, 200, service.getSnapshot());
    return;
  }
  if (url.pathname === "/api/desire/satisfy" && request.method === "POST") {
    const body = await readJsonBody(request);
    service.satisfyAction(body.action);
    sendJson(response, 200, service.getSnapshot());
    return;
  }

  serveStatic(url.pathname, response);
}

function serveStatic(pathname, response) {
  const normalizedPath = pathname === "/" ? "/index.html" : pathname;
  const relativePath = normalizedPath.replace(/^\/+/, "");
  const filePath = path.resolve(PANEL_DIR, relativePath);
  const panelRoot = path.resolve(PANEL_DIR);
  const relativeToRoot = path.relative(panelRoot, filePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  let stats = null;
  try {
    stats = fs.statSync(filePath);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }
  if (!stats.isFile()) {
    sendText(response, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(response);
}

function listenOnAvailablePort(server, { host, port, attempts }) {
  let nextPort = port;
  let remaining = attempts;
  return new Promise((resolve, reject) => {
    const tryListen = () => {
      const onError = (error) => {
        server.off("listening", onListening);
        if (error?.code === "EADDRINUSE" && remaining > 1) {
          remaining -= 1;
          nextPort += 1;
          setImmediate(tryListen);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        resolve({
          host,
          port: typeof address === "object" && address ? address.port : nextPort,
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(nextPort, host);
    };
    tryListen();
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    request.on("data", (chunk) => {
      totalLength += chunk.length;
      if (totalLength > 1024 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { runDesirePanelServer };
