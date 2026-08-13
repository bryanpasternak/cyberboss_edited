const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const MEMENTO_TYPES = ["gift", "postcard", "travel_card"];

class MementoStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new Error("MementoStore requires rootDir");
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  create({ type, createdBy, givenTo, status, data = {}, assets = {} }) {
    if (!MEMENTO_TYPES.includes(type)) throw new Error(`Unsupported memento type: ${type}`);
    const now = new Date().toISOString();
    const id = `${type}_${crypto.randomUUID()}`;
    const record = normalizeRecord({
      id,
      type,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      createdBy,
      givenTo,
      status,
      assetIds: [],
      assets,
      data,
    });
    this.save(record);
    return record;
  }

  read(id) {
    const recordPath = this.recordPath(id);
    if (!fs.existsSync(recordPath)) throw new Error(`Memento not found: ${id}`);
    const parsed = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return normalizeRecord(parsed);
  }

  save(record) {
    const normalized = normalizeRecord({ ...record, updatedAt: new Date().toISOString() });
    const dir = this.itemDir(normalized.id);
    fs.mkdirSync(dir, { recursive: true });
    const target = this.recordPath(normalized.id);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(normalized, null, 2), "utf8");
    fs.renameSync(temp, target);
    return normalized;
  }

  update(id, mutator) {
    const current = this.read(id);
    const next = typeof mutator === "function" ? mutator(current) : current;
    if (!next || next.id !== current.id || next.type !== current.type) {
      throw new Error("Memento update cannot change id or type");
    }
    return this.save(next);
  }

  list({ type = "", status = "" } = {}) {
    if (!fs.existsSync(this.rootDir)) return [];
    const records = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const record = this.read(entry.name);
        if (type && record.type !== type) continue;
        if (status && record.status !== status) continue;
        records.push(record);
      } catch {
        // Ignore unrelated or incomplete directories; never overwrite them.
      }
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  itemDir(id) {
    const normalized = normalizeId(id);
    const target = path.resolve(this.rootDir, normalized);
    if (!target.startsWith(`${this.rootDir}${path.sep}`)) throw new Error("Invalid memento id");
    return target;
  }

  recordPath(id) {
    return path.join(this.itemDir(id), "record.json");
  }
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid memento record");
  const version = Number(value.schemaVersion);
  if (version !== SCHEMA_VERSION) throw new Error(`Unsupported memento schema version: ${version}`);
  const id = normalizeId(value.id);
  const type = text(value.type);
  if (!MEMENTO_TYPES.includes(type)) throw new Error(`Unsupported memento type: ${type}`);
  return {
    id,
    type,
    schemaVersion: SCHEMA_VERSION,
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
    createdBy: text(value.createdBy) || "moonlet",
    givenTo: text(value.givenTo) || "susu",
    status: text(value.status) || "created",
    assetIds: Array.isArray(value.assetIds) ? value.assetIds.map(text).filter(Boolean) : [],
    assets: value.assets && typeof value.assets === "object" ? { ...value.assets } : {},
    data: value.data && typeof value.data === "object" ? { ...value.data } : {},
  };
}

function normalizeId(value) {
  const normalized = text(value);
  if (!/^[a-z][a-z0-9_\-]{8,100}$/i.test(normalized)) throw new Error("Invalid memento id");
  return normalized;
}

function iso(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { MementoStore, MEMENTO_TYPES, SCHEMA_VERSION };
