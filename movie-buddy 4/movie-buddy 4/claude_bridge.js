#!/usr/bin/env node
"use strict";

// Movie Buddy backend: Claude Code.
//
// Runs one long-lived `claude -p` process in streaming-JSON mode and feeds it
// the message queue produced by server.py. Every turn carries the current video
// frame as a base64 image block plus the text context the server assembled.
//
// Runtime contract (shared with codex_bridge.js):
//   read : runtime/message_queue.jsonl, runtime/current_frame.jpg
//   write: runtime/bridge_status.json, runtime/response.json
//
// All built-in tools are disabled, so the agent can do exactly one thing:
// reply with text. It cannot read, write, or execute anything on this machine.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { readConfig } = require("./load_config");

const ROOT = __dirname;
const RUNTIME = path.join(ROOT, "runtime");
const QUEUE_FILE = path.join(RUNTIME, "message_queue.jsonl");
const FRAME_FILE = path.join(RUNTIME, "current_frame.jpg");
const STATE_FILE = path.join(RUNTIME, "claude_bridge_state.json");
const STATUS_FILE = path.join(RUNTIME, "bridge_status.json");
const RESPONSE_FILE = path.join(RUNTIME, "response.json");
const SYSTEM_PROMPT_FILE = path.join(RUNTIME, "system_prompt.txt");

const TURN_TIMEOUT_MS = 180000;
const MAX_RESTARTS_PER_MINUTE = 6;

const config = readConfig();
const claudeConfig = config.claude || {};
const silentToken = (config.prompts && config.prompts.silentToken) || "[SILENT]";

let state = readJson(STATE_FILE, { sessionId: null, processed: [] });
let child = null;
let ready = false;
let shuttingDown = false;
let active = null;
let stdoutBuffer = "";
let turnTimer = null;
let restartTimes = [];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
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
  atomicWrite(
    STATUS_FILE,
    `${JSON.stringify({ status: value, backend: "claude", updatedAt: new Date().toISOString(), ...extra }, null, 2)}\n`
  );
}

function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs
    .readFileSync(QUEUE_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const item = JSON.parse(line);
        return item.id && item.text ? [item] : [];
      } catch {
        return [];
      }
    });
}

function writeSystemPrompt() {
  const persona = String(config.persona || "You are a warm, concise movie-watching companion.")
    .replaceAll("{userName}", config.userName || "the viewer")
    .replaceAll("{buddyName}", config.buddyName || "Buddy");
  atomicWrite(SYSTEM_PROMPT_FILE, `${persona}\n`);
  return SYSTEM_PROMPT_FILE;
}

function buildArgs() {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt-file",
    writeSystemPrompt(),
    // No tools at all: the agent can only produce text. This is stricter than
    // a read-only sandbox, because nothing on the machine is reachable.
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    // Do not load any MCP server the user happens to have configured.
    "--strict-mcp-config",
  ];
  if (claudeConfig.model) args.push("--model", String(claudeConfig.model));
  if (claudeConfig.bare) args.push("--bare");
  if (state.sessionId) args.push("--resume", state.sessionId);
  else {
    state.sessionId = crypto.randomUUID();
    saveState();
    args.push("--session-id", state.sessionId);
  }
  if (Array.isArray(claudeConfig.extraArgs)) args.push(...claudeConfig.extraArgs.map(String));
  return args;
}

function throttledRestart() {
  const now = Date.now();
  restartTimes = restartTimes.filter((at) => now - at < 60000);
  if (restartTimes.length >= MAX_RESTARTS_PER_MINUTE) {
    status("error", {
      error:
        "Claude Code keeps exiting on startup. Run `claude -p \"hi\"` in a terminal to check that the CLI is installed and signed in.",
    });
    return false;
  }
  restartTimes.push(now);
  return true;
}

function startChild() {
  if (shuttingDown) return;
  if (!throttledRestart()) return;

  const command = claudeConfig.command || "claude";
  const args = buildArgs();
  status("starting", { detail: `${command} ${args.join(" ")}` });

  child = spawn(command, args, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  ready = false;
  stdoutBuffer = "";

  child.on("error", (error) => {
    const hint =
      error.code === "ENOENT"
        ? `Could not find the \`${command}\` command. Install Claude Code (npm install -g @anthropic-ai/claude-code) or set claude.command in config.json.`
        : error.message;
    status("error", { error: hint });
    child = null;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line && !ready) status("starting", { detail: line.slice(-500) });
  });

  child.on("exit", (code) => {
    child = null;
    ready = false;
    if (shuttingDown) return;
    // A turn that was in flight when the process died goes back on the queue by
    // simply not being marked processed; it is retried after the restart.
    if (active) {
      clearTimeout(turnTimer);
      active = null;
    }
    status("starting", { detail: `Claude Code exited (code ${code}); reconnecting to the same session.` });
    setTimeout(startChild, 800);
  });
}

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === "system" && message.subtype === "init") {
    if (message.session_id) {
      state.sessionId = message.session_id;
      saveState();
    }
    ready = true;
    restartTimes = [];
    if (!active) status("ready");
    return;
  }

  if (message.type === "system" && message.subtype === "api_retry") {
    status("thinking", { detail: `retrying (${message.attempt}/${message.max_retries})` });
    return;
  }

  if (message.type !== "result") return;

  clearTimeout(turnTimer);
  const current = active;
  active = null;
  if (!current) return;

  if (message.subtype !== "success" || message.is_error) {
    status("error", { error: String(message.result || message.subtype || "Claude Code returned an error") });
    // Mark it processed anyway so one bad frame cannot wedge the queue forever.
    state.processed.push(current.id);
    saveState();
    return;
  }

  const text = String(message.result || "").trim();
  if (text && text !== silentToken) {
    atomicWrite(
      RESPONSE_FILE,
      `${JSON.stringify({ id: current.id, text, at: new Date().toISOString() }, null, 2)}\n`
    );
  }
  state.processed.push(current.id);
  saveState();
  status("ready");
}

function sendTurn(item) {
  const content = [{ type: "text", text: item.text }];
  if (item.frameAttached && fs.existsSync(FRAME_FILE)) {
    try {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: fs.readFileSync(FRAME_FILE).toString("base64"),
        },
      });
    } catch {
      // A frame we cannot read is not worth losing the turn over.
    }
  }

  const envelope = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };

  active = { id: item.id, startedAt: Date.now() };
  status("thinking", { messageId: item.id, frameAttached: content.length > 1 });

  try {
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
  } catch (error) {
    active = null;
    status("error", { error: `Could not reach Claude Code: ${error.message}` });
    return;
  }

  turnTimer = setTimeout(() => {
    if (!active || active.id !== item.id) return;
    active = null;
    status("error", { error: "Claude Code did not answer in time." });
    if (child) child.kill();
  }, TURN_TIMEOUT_MS);
}

setInterval(() => {
  if (!ready || active || !child || shuttingDown) return;
  const processed = new Set(state.processed || []);
  const next = readQueue().find((item) => !processed.has(item.id));
  if (next) sendTurn(next);
}, 400);

function shutdown() {
  shuttingDown = true;
  clearTimeout(turnTimer);
  try {
    child?.stdin?.end();
  } catch {}
  if (child && !child.killed) child.kill();
  status("stopped");
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
fs.mkdirSync(RUNTIME, { recursive: true });
startChild();
