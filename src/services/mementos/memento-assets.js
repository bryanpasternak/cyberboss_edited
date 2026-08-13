const fs = require("fs");
const path = require("path");

class MementoAssets {
  constructor({ store }) {
    this.store = store;
  }

  writeSvg(mementoId, role, svg) {
    const safeRole = String(role || "asset").trim().replace(/[^a-z0-9_-]/gi, "-");
    const dir = path.join(this.store.itemDir(mementoId), "assets");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeRole}.svg`);
    fs.writeFileSync(filePath, String(svg || ""), "utf8");
    return {
      id: `${mementoId}_${safeRole}`,
      role: safeRole,
      mimeType: "image/svg+xml",
      relativePath: path.relative(this.store.rootDir, filePath).replace(/\\/g, "/"),
      filePath,
    };
  }

  resolve(asset) {
    if (!asset || typeof asset !== "object") return null;
    const filePath = path.resolve(this.store.rootDir, String(asset.relativePath || ""));
    if (!filePath.startsWith(`${this.store.rootDir}${path.sep}`) || !fs.existsSync(filePath)) return null;
    return { ...asset, filePath };
  }
}

module.exports = { MementoAssets };
