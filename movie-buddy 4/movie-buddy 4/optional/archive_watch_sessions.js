#!/usr/bin/env node

// Long-term memory adapter.
//
// Movie Buddy keeps no long-term memory of its own. The persistent side — the
// conversation that survives across sessions — is Stone Memory, written by
// 来放松一会 (https://github.com/wanyu445). This script only READS through Stone
// Memory's official read layer and writes local archives; it never writes back.
//
// Stone Memory is in closed beta and its repository is invite-only, so this file
// is a worked example for most readers rather than something they can run.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readConfig } = require("../load_config");

// The bridge writes the film name using the label from config.prompts, so the
// archive has to look for the same label rather than a hard-coded string.
const config = readConfig();
const MOVIE_LABEL = (config.prompts && config.prompts.movieLabel) || "Film";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function safeSlug(title) {
  const readable = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[\s.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "movie";
  const digest = crypto.createHash("sha256").update(title).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

function movieTitle(text) {
  const escaped = MOVIE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`(?:^|\\n)${escaped}[:：]\\s*([^\\n]+)`));
  return match ? match[1].trim() : "";
}

function groupWatchMessages(messages) {
  const groups = new Map();
  let pendingTitle = "";
  for (const row of messages) {
    const title = movieTitle(row.text);
    if (row.type === "user" && title) {
      pendingTitle = title;
      if (!groups.has(title)) groups.set(title, []);
      groups.get(title).push({ timestamp: row.timestamp, role: row.type, text: row.text });
      continue;
    }
    if (row.type === "assistant" && pendingTitle) {
      groups.get(pendingTitle).push({ timestamp: row.timestamp, role: row.type, text: row.text });
      pendingTitle = "";
    }
  }
  return groups;
}

function splitForMining(rows, maxBytes = 45 * 1024) {
  const chunks = [];
  let pending = [];
  let pendingBytes = 0;
  for (let index = 0; index < rows.length; index += 2) {
    const pair = rows.slice(index, index + 2);
    const pairBytes = Buffer.byteLength(pair.map(row => row.text).join("\n"), "utf8");
    if (pending.length && pendingBytes + pairBytes > maxBytes) {
      chunks.push(pending);
      pending = [];
      pendingBytes = 0;
    }
    pending.push(...pair);
    pendingBytes += pairBytes;
  }
  if (pending.length) chunks.push(pending);
  return chunks;
}

function main() {
  const stoneRepo = path.resolve(option("--stone-repo"));
  const date = option("--date");
  const target = option("--target");
  if (!stoneRepo || !fs.existsSync(stoneRepo)) throw new Error("--stone-repo must point at an existing directory");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");

  const appDir = path.resolve(__dirname, "..");
  const runtimeDir = path.join(appDir, "runtime");
  const bridgeState = JSON.parse(fs.readFileSync(path.join(runtimeDir, "codex_bridge_state.json"), "utf8"));
  const { getThreadDir } = require(path.join(stoneRepo, "src", "config"));
  const { MemoryStore } = require(path.join(stoneRepo, "src", "storage", "memory-store"));
  const memoryDir = path.join(getThreadDir(bridgeState.threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId: bridgeState.threadId });

  let messages;
  try {
    messages = store.listMessages({ date });
  } finally {
    store.close();
  }

  const ignoredTitles = new Set(["unknown film"]);
  const groups = groupWatchMessages(messages);
  const archiveRoot = path.join(runtimeDir, "watch-sessions");
  fs.mkdirSync(archiveRoot, { recursive: true });
  const index = [];

  for (const [title, rows] of groups) {
    if (ignoredTitles.has(title)) continue;
    const slug = safeSlug(title);
    const folder = path.join(archiveRoot, `${date}-${slug}`);
    fs.mkdirSync(folder, { recursive: true });
    const turns = rows.filter(row => row.role === "user").length;
    const archive = {
      version: 1,
      generatedAt: new Date().toISOString(),
      source: { kind: "stone-memory-read-view", date },
      film: { title, slug },
      stats: {
        turns,
        messages: rows.length,
        startedAt: rows[0]?.timestamp || null,
        endedAt: rows.at(-1)?.timestamp || null,
      },
      messages: rows,
    };
    fs.writeFileSync(path.join(folder, "session.json"), `${JSON.stringify(archive, null, 2)}\n`, "utf8");
    index.push({ ...archive.film, ...archive.stats, path: path.relative(archiveRoot, folder) });

    if (target && title === target) {
      const chunks = splitForMining(rows);
      const batchFiles = [];
      chunks.forEach((chunk, index) => {
        const filename = `targeted-batch-${String(index + 1).padStart(3, "0")}.json`;
        const batch = {
          date,
          timestamps: chunk.map(row => row.timestamp),
          instruction: `Segment ${index + 1}/${chunks.length} of the watch archive for "${title}". Summarise only what actually happened between the viewer and the companion: the exchanges, the reactions, the shared milestones. Ignore player-control chatter, repeated proactive templates, and raw subtitle transcription. Do not retell the plot, and do not repeat summaries that already exist for this day.`,
        };
        fs.writeFileSync(path.join(folder, filename), `${JSON.stringify(batch, null, 2)}\n`, "utf8");
        batchFiles.push({ filename, messages: chunk.length });
      });
      fs.writeFileSync(path.join(folder, "targeted-batches.json"), `${JSON.stringify({ date, title, totalMessages: rows.length, parts: batchFiles }, null, 2)}\n`, "utf8");
    }
  }

  index.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  fs.writeFileSync(path.join(archiveRoot, "index.json"), `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), films: index }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ date, archiveRoot, films: index.map(({ title, turns, messages, path: archivePath }) => ({ title, turns, messages, path: archivePath })) }, null, 2)}\n`);
}

main();
