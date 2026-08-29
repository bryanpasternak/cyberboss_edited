"use strict";

// Shared configuration loader for the Node bridges.
//
// Resolution order:
//   1. MOVIE_BUDDY_CONFIG env var (JSON string) — set by server.py so the
//      bridge and the server always agree on one resolved config.
//   2. config.json next to this file.
//   3. config.example.json (the committed defaults).

const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return result;
}

function readConfig() {
  if (process.env.MOVIE_BUDDY_CONFIG) {
    const parsed = readJsonFromString(process.env.MOVIE_BUDDY_CONFIG);
    if (parsed) return parsed;
  }
  const defaults = readJsonFile(path.join(ROOT, "config.example.json")) || {};
  const local = readJsonFile(path.join(ROOT, "config.json"));
  return local ? merge(defaults, local) : defaults;
}

function readJsonFromString(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { readConfig, merge, ROOT };
