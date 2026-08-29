const fs = require("fs");
const path = require("path");

class JsonCollectionStore {
  constructor({ filePath }) {
    this.filePath = filePath;
  }

  read() {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    if (!Array.isArray(raw.items)) throw new Error(`Invalid collection file: ${this.filePath}`);
    return raw.items;
  }

  write(items) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, "utf8");
    fs.renameSync(temp, this.filePath);
  }
}

module.exports = { JsonCollectionStore };
