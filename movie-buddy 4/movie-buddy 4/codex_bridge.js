#!/usr/bin/env node
"use strict";

// Movie Buddy backend: Codex.
//
// Derived from the direct Codex bridge written by 利未 (https://github.com/Liooowei)
// for Game Buddy, which replaced once-a-minute polling with a live connection.
// Reworked here to follow Movie Buddy's bridge contract (see ARCHITECTURE.md).

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readConfig } = require("./load_config");

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, "runtime");
const QUEUE_FILE = path.join(RUNTIME, "message_queue.jsonl");
const FRAME_FILE = path.join(RUNTIME, "current_frame.jpg");
const STATE_FILE = path.join(RUNTIME, "codex_bridge_state.json");
const STATUS_FILE = path.join(RUNTIME, "bridge_status.json");
const RESPONSE_FILE = path.join(RUNTIME, "response.json");

const config = readConfig();
const codexConfig = config.codex || {};
const silentToken = (config.prompts && config.prompts.silentToken) || "[SILENT]";
const persona = String(config.persona || "You are a warm, concise movie-watching companion.")
  .replaceAll("{userName}", config.userName || "the viewer")
  .replaceAll("{buddyName}", config.buddyName || "Buddy");
const ENDPOINT = process.env.MOVIE_BUDDY_CODEX_ENDPOINT || codexConfig.endpoint || "ws://127.0.0.1:8766";

let state = readJson(STATE_FILE, { threadId: null, processed: [], inFlight: null });
let socket = null;
let requestId = 1;
let pending = new Map();
let active = null;
let connected = false;
let appServer = null;
let spawnedServer = false;
let shuttingDown = false;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, value, "utf8");
  fs.renameSync(temp, file);
}

function saveState() {
  state.processed = [...new Set(Array.isArray(state.processed) ? state.processed : [])].slice(-5000);
  atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function status(value, extra = {}) {
  atomicWrite(STATUS_FILE, `${JSON.stringify({ status: value, backend: "codex", updatedAt: new Date().toISOString(), ...extra }, null, 2)}\n`);
}

function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const item = JSON.parse(line);
      return item.id && item.text ? [item] : [];
    } catch { return []; }
  });
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("The local Codex connection is not ready yet");
  socket.send(JSON.stringify(message));
}

function request(method, params = {}) {
  const id = requestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} request timed out`));
    }, 90000);
    pending.set(id, { resolve, reject, timer, method });
    send({ id, method, params });
  });
}

async function eventText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (typeof value?.text === "function") return value.text();
  return String(value);
}

async function onMessage(event) {
  let message;
  try { message = JSON.parse(await eventText(event.data)); } catch { return; }
  if (Object.prototype.hasOwnProperty.call(message, "id")) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || `${item.method} failed`));
    else item.resolve(message.result);
    return;
  }

  const params = message.params || {};
  if (!active) return;
  if (message.method === "item/completed" && params.turnId === active.turnId) {
    const item = params.item || {};
    if (item.type === "agentMessage" && typeof item.text === "string") {
      if (item.phase === "final_answer") active.final = item.text.trim();
      else active.fallback = item.text.trim();
    }
  } else if (message.method === "item/agentMessage/delta" && params.turnId === active.turnId) {
    active.delta += params.delta || "";
  } else if (message.method === "turn/completed" && params.turn?.id === active.turnId) {
    const text = active.final || active.fallback || active.delta.trim();
    if (params.turn.status === "completed" && text) {
      if (text.trim() !== silentToken) {
        atomicWrite(RESPONSE_FILE, `${JSON.stringify({ id: active.message.id, text, at: new Date().toISOString() }, null, 2)}\n`);
      }
      state.processed.push(active.message.id);
      state.inFlight = null;
      saveState();
      active = null;
      status("ready");
    } else {
      state.inFlight = null;
      saveState();
      status("error", { error: params.turn?.error?.message || "Codex did not return a complete reply" });
      active = null;
    }
  }
}

async function initialize() {
  await request("initialize", {
    clientInfo: { name: "movie_buddy", title: "Movie Buddy", version: "0.1.0" },
    capabilities: { optOutNotificationMethods: [] },
  });
  send({ method: "initialized", params: {} });

  if (state.threadId) {
    try {
      const result = await request("thread/resume", {
        threadId: state.threadId,
        cwd: ROOT,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      state.threadId = result?.thread?.id || state.threadId;
    } catch {
      state.threadId = null;
    }
  }
  if (!state.threadId) {
    const result = await request("thread/start", {
      cwd: ROOT,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    state.threadId = result?.thread?.id;
    if (!state.threadId) throw new Error("Could not create a dedicated Movie Buddy thread");
  }
  saveState();
  connected = true;
  status("ready");
}

function spawnAppServer() {
  if (spawnedServer || shuttingDown) return;
  spawnedServer = true;
  appServer = spawn(codexConfig.command || "codex", ["app-server", "--listen", ENDPOINT], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  appServer.stderr?.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line && !connected) status("starting", { detail: line.slice(-500) });
  });
  appServer.on("error", (error) => status("error", { error: `Could not start the Codex app-server: ${error.message}` }));
}

function connect(attempt = 0) {
  if (shuttingDown) return;
  status("starting", { attempt: attempt + 1 });
  socket = new WebSocket(ENDPOINT);
  let opened = false;
  socket.onopen = () => {
    opened = true;
    void initialize().catch((error) => {
      status("error", { error: error.message });
      socket.close();
    });
  };
  socket.onmessage = (event) => void onMessage(event);
  socket.onerror = () => {};
  socket.onclose = () => {
    connected = false;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("The local Codex connection dropped"));
    }
    pending.clear();
    if (!opened && attempt === 0) spawnAppServer();
    if (!shuttingDown) setTimeout(() => connect(attempt + 1), Math.min(10000, 600 + attempt * 700));
  };
}

async function sendNext(message) {
  // Codex has no separate system-prompt channel here, so the persona rides
  // along with every turn. The Claude backend uses --system-prompt-file instead.
  const prompt = [persona, message.text].join("\n\n");
  const input = [{ type: "text", text: prompt }];
  if (message.frameAttached && fs.existsSync(FRAME_FILE)) {
    input.push({ type: "localImage", path: path.resolve(FRAME_FILE), detail: "auto" });
  }
  active = { message, turnId: null, final: "", fallback: "", delta: "" };
  state.inFlight = { messageId: message.id, startedAt: Date.now() };
  saveState();
  status("thinking", { messageId: message.id, screenshotAttached: input.length > 1 });
  try {
    const result = await request("turn/start", {
      threadId: state.threadId,
      input,
      clientUserMessageId: message.id,
    });
    active.turnId = result?.turn?.id;
    if (!active.turnId) throw new Error("Codex did not return a turn id");
  } catch (error) {
    active = null;
    state.inFlight = null;
    saveState();
    status("error", { error: error.message });
  }
}

setInterval(() => {
  if (!connected || active) return;
  const processed = new Set(state.processed || []);
  const next = readQueue().find((item) => !processed.has(item.id));
  if (next) void sendNext(next);
}, 400);

function shutdown() {
  shuttingDown = true;
  try { socket?.close(); } catch {}
  if (appServer && !appServer.killed) appServer.kill();
  status("stopped");
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
fs.mkdirSync(RUNTIME, { recursive: true });
connect();
