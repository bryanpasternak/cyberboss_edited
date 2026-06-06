const fs = require("fs");
const path = require("path");

const { createDefaultState, normalizeState } = require("./desire-engine");

class DesireStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.ensureParentDirectory();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch {
      return createDefaultState();
    }
  }

  save(state) {
    const normalized = normalizeState(state);
    this.ensureParentDirectory();
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2));
    return normalized;
  }

  update(mutator) {
    const current = this.load();
    const next = typeof mutator === "function" ? mutator(current) : current;
    return this.save(next);
  }
}

module.exports = { DesireStore };
