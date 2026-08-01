"use strict";

const { URLSearchParams } = require("url");

const BASE_URL = String(process.env.READ_ALONG_BASE_URL || "http://127.0.0.1:18004").replace(/\/+$/, "");

const TOOLS = [
  {
    name: "read_along_health",
    description: "检查共读后端是否正在运行，以及正文推送是否开启。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_along_list_books",
    description: "列出共读书架中的书、阅读进度和批注数量。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_along_progress",
    description: "查看一本书当前已解锁的阅读进度。不会暴露未读章节。",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string", description: "书籍 ID" } },
      required: ["bookId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_along_read",
    description: "回看一本书已经随共读推送过来的段落，最多 200 段；未解锁内容不会返回。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        from: { type: "integer", minimum: 0, description: "起始段落序号（含）" },
        to: { type: "integer", minimum: 0, description: "结束段落序号（含）" },
      },
      required: ["bookId", "from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "read_along_search",
    description: "只在已经随共读推送过来的正文中搜索，不会检索或泄露后文。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        query: { type: "string", description: "搜索文字" },
      },
      required: ["bookId", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_along_list_annotations",
    description: "查看一本书的页边批注及双方回复。",
    inputSchema: {
      type: "object",
      properties: { bookId: { type: "string", description: "书籍 ID" } },
      required: ["bookId"],
      additionalProperties: false,
    },
  },
  {
    name: "read_along_annotate",
    description: "给已经解锁的原文写一条 AI 页边批注。只在确实有感触时使用；quote 必须逐字引用已读原文。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        quote: { type: "string", description: "已解锁原文中的逐字引用；若重复请引用更长片段" },
        comment: { type: "string", description: "想留在页边的批注" },
      },
      required: ["bookId", "quote", "comment"],
      additionalProperties: false,
    },
  },
  {
    name: "read_along_reply",
    description: "回复苏苏或 AI 已有的一条页边批注。",
    inputSchema: {
      type: "object",
      properties: {
        bookId: { type: "string", description: "书籍 ID" },
        annotationId: { type: "string", description: "批注 ID" },
        text: { type: "string", description: "回复内容" },
      },
      required: ["bookId", "annotationId", "text"],
      additionalProperties: false,
    },
  },
];

function requiredString(args, key) {
  const value = args && args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function encodeArg(args, key) {
  return encodeURIComponent(requiredString(args, key));
}

async function requestJson(pathname, options = {}) {
  let response;
  try {
    response = await fetch(`${BASE_URL}${pathname}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
  } catch (error) {
    throw new Error(`共读后端未连接（${BASE_URL}）：${error.message}`);
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`共读后端返回 ${response.status}：${data.error || raw || response.statusText}`);
  return data;
}

async function invoke(name, args = {}) {
  if (name === "read_along_health") return requestJson("/health");
  if (name === "read_along_list_books") return requestJson("/api/books");

  if (name === "read_along_progress") {
    return requestJson(`/api/gate/${encodeArg(args, "bookId")}`);
  }
  if (name === "read_along_read") {
    if (!Number.isInteger(args.from) || !Number.isInteger(args.to)) throw new Error("from and to must be integers");
    const qs = new URLSearchParams({ from: String(args.from), to: String(args.to) });
    return requestJson(`/api/gate/${encodeArg(args, "bookId")}/text?${qs}`);
  }
  if (name === "read_along_search") {
    const qs = new URLSearchParams({ q: requiredString(args, "query") });
    return requestJson(`/api/gate/${encodeArg(args, "bookId")}/search?${qs}`);
  }
  if (name === "read_along_list_annotations") {
    return requestJson(`/api/annotations/${encodeArg(args, "bookId")}`);
  }
  if (name === "read_along_annotate") {
    return requestJson("/api/annotate", {
      method: "POST",
      body: JSON.stringify({
        bookId: requiredString(args, "bookId"),
        quote: requiredString(args, "quote"),
        comment: requiredString(args, "comment"),
      }),
    });
  }
  if (name === "read_along_reply") {
    return requestJson(`/api/annotations/${encodeArg(args, "bookId")}/${encodeArg(args, "annotationId")}/comment`, {
      method: "POST",
      body: JSON.stringify({ author: "ai", text: requiredString(args, "text") }),
    });
  }
  throw new Error(`unknown tool: ${name}`);
}

let framing = "jsonl";

function send(message) {
  const json = JSON.stringify(message);
  if (framing === "content-length") {
    const body = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function handle(message) {
  const { id, method, params = {} } = message || {};
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "read-along", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await invoke(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error.message }], isError: true } });
    }
    return;
  }
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let input = Buffer.alloc(0);
let queue = Promise.resolve();

function enqueue(message) {
  queue = queue.then(() => handle(message)).catch((error) => {
    process.stderr.write(`[read-along-mcp] ${error.stack || error.message}\n`);
  });
}

function parseInput() {
  while (input.length) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd >= 0 && input.slice(0, headerEnd).toString("ascii").toLowerCase().includes("content-length:")) {
      const header = input.slice(0, headerEnd).toString("ascii");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (input.length < bodyStart + length) return;
      framing = "content-length";
      const body = input.slice(bodyStart, bodyStart + length).toString("utf8");
      input = input.slice(bodyStart + length);
      try { enqueue(JSON.parse(body)); } catch {}
      continue;
    }
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    framing = "jsonl";
    const line = input.slice(0, newline).toString("utf8").trim();
    input = input.slice(newline + 1);
    if (line) {
      try { enqueue(JSON.parse(line)); } catch {}
    }
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  parseInput();
});
