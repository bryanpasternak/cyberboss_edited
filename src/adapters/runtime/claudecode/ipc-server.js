const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { resolveClaudeIpcEndpoint } = require("./ipc-endpoint");

class ClaudeCodeIpcServer extends EventEmitter {
  constructor({ socketPath, endpoint = null }) {
    super();
    this.endpoint = endpoint || resolveClaudeIpcEndpoint(path.dirname(socketPath || ""));
    this.socketPath = this.endpoint.path;
    this.displayPath = this.endpoint.displayPath;
    this.tokenFile = this.endpoint.tokenFile;
    this.authToken = "";
    this.server = null;
    this.clients = new Set();
    this.authenticated = new Set();
    this.observerWorkspaceByClient = new Map();
  }

  start() {
    if (this.server) return;
    this.ensureDirectory();
    this.removeStaleSocket();
    this.generateAuthToken();

    this.server = net.createServer((socket) => {
      this.clients.add(socket);
      socket.setEncoding("utf8");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (!this.authenticated.has(socket)) {
              if (msg?.type === "auth" && msg?.token === this.authToken) {
                this.authenticated.add(socket);
              }
              continue;
            }
            if (validateIpcMessage(msg)) {
              if (msg?.type === "observeWorkspace") {
                this.setObserverWorkspace(msg.workspaceRoot, socket);
              }
              this.emit("clientMessage", msg, socket);
            }
          } catch {
            // ignore malformed
          }
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
        this.observerWorkspaceByClient.delete(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
        this.authenticated.delete(socket);
        this.observerWorkspaceByClient.delete(socket);
      });
    });

    this.server.on("error", (error) => {
      console.error(`[claudecode-runtime] ipc server error path=${this.displayPath} error=${error.message}`);
    });

    this.server.listen(this.socketPath, () => {
      if (this.endpoint.kind === "socket") {
        fs.chmodSync(this.socketPath, 0o600);
      }
    });
  }

  broadcast(event) {
    const payload = JSON.stringify(event) + "\n";
    for (const client of this.authenticated) {
      if (!this.shouldDeliverEventToClient(client, event)) {
        continue;
      }
      try {
        client.write(payload);
      } catch {
        // ignore dead sockets
      }
    }
  }

  setObserverWorkspace(workspaceRoot = "", socket = null) {
    if (!socket) {
      return;
    }
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!normalizedWorkspaceRoot) {
      this.observerWorkspaceByClient.delete(socket);
      return;
    }
    this.observerWorkspaceByClient.set(socket, normalizedWorkspaceRoot);
  }

  shouldDeliverEventToClient(socket, event) {
    if (!socket || !event || typeof event !== "object") {
      return true;
    }
    const observedWorkspaceRoot = this.observerWorkspaceByClient.get(socket);
    if (!observedWorkspaceRoot) {
      return true;
    }
    if (event.type === "stderr") {
      return true;
    }
    if (event.type === "inboundMessage") {
      return normalizeWorkspaceRoot(event.workspaceRoot) === observedWorkspaceRoot;
    }
    if (event.type !== "processEvent") {
      return true;
    }
    const eventWorkspaceRoot = normalizeWorkspaceRoot(event.event?.workspaceRoot || event.raw?.workspaceRoot);
    return !eventWorkspaceRoot || eventWorkspaceRoot === observedWorkspaceRoot;
  }

  ensureDirectory() {
    const dir = path.dirname(this.tokenFile);
    fs.mkdirSync(dir, { recursive: true });
  }

  removeStaleSocket() {
    if (this.endpoint.kind !== "socket") {
      return;
    }
    try {
      const stat = fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) {
        return;
      }
      fs.unlinkSync(this.socketPath);
    } catch {
      // ignore
    }
  }

  generateAuthToken() {
    this.authToken = crypto.randomBytes(32).toString("hex");
    try {
      fs.writeFileSync(this.tokenFile, this.authToken, { mode: 0o600 });
    } catch {
      // ignore
    }
  }

  removeAuthToken() {
    try {
      fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }

  async close() {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
    this.authenticated.clear();

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
      this.server = null;
    }

    this.removeStaleSocket();
    this.removeAuthToken();
  }
}

function validateIpcMessage(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return false;
  }
  const type = msg.type;
  if (typeof type !== "string") {
    return false;
  }
  switch (type) {
    case "sendUserMessage":
      return typeof msg.workspaceRoot === "string" && typeof msg.text === "string";
    case "respondApproval":
      return typeof msg.workspaceRoot === "string" && typeof msg.requestId === "string";
    case "observeWorkspace":
      return typeof msg.workspaceRoot === "string";
    default:
      return true;
  }
}

function normalizeWorkspaceRoot(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ClaudeCodeIpcServer };
