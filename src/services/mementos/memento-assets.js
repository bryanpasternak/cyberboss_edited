const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

class MementoAssets {
  constructor({ store, importRoots = [] }) {
    this.store = store;
    this.importRoots = [...new Set([
      this.store.rootDir,
      process.cwd(),
      ...(Array.isArray(importRoots) ? importRoots : []),
    ].map((root) => path.resolve(String(root || ""))))];
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

  writeBuffer(mementoId, role, buffer, { extension = ".bin", mimeType = "application/octet-stream", metadata = {} } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Asset buffer is required");
    const safeRole = safeAssetPart(role || "asset");
    const safeExtension = normalizeExtension(extension);
    const dir = path.join(this.store.itemDir(mementoId), "assets");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeRole}${safeExtension}`);
    fs.writeFileSync(filePath, buffer);
    return {
      id: `${mementoId}_${safeRole}`,
      role: safeRole,
      mimeType: String(mimeType || "application/octet-stream"),
      relativePath: path.relative(this.store.rootDir, filePath).replace(/\\/g, "/"),
      filePath,
      ...metadata,
    };
  }

  async importImage(mementoId, role, sourcePath) {
    const filePath = this.resolveImportPath(sourcePath);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Postcard art source must be a file");
    if (stat.size > 25 * 1024 * 1024) throw new Error("Postcard art source exceeds 25 MB");
    const buffer = fs.readFileSync(filePath);
    return this.writeImageBuffer(mementoId, role, buffer);
  }

  async writeImageBuffer(mementoId, role, inputBuffer) {
    if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) throw new Error("Image buffer is required");
    const image = sharp(inputBuffer, { failOn: "error" }).rotate();
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 64 || metadata.height < 64) {
      throw new Error("Postcard art image is too small or invalid");
    }
    const normalized = await image
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return this.writeBuffer(mementoId, role, normalized, {
      extension: ".png",
      mimeType: "image/png",
      metadata: { width: metadata.width, height: metadata.height },
    });
  }

  resolveImportPath(sourcePath) {
    const normalized = String(sourcePath || "").trim();
    if (!normalized || !path.isAbsolute(normalized)) throw new Error("Postcard art source must be an absolute local path");
    if (!fs.existsSync(normalized)) throw new Error("Postcard art source does not exist");
    const source = fs.realpathSync(normalized);
    const allowed = this.importRoots.some((root) => {
      if (!fs.existsSync(root)) return false;
      const resolvedRoot = fs.realpathSync(root);
      const relative = path.relative(resolvedRoot, source);
      return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    });
    if (!allowed) throw new Error("Postcard art source is outside allowed import roots");
    return source;
  }

  resolve(asset) {
    if (!asset || typeof asset !== "object") return null;
    const filePath = path.resolve(this.store.rootDir, String(asset.relativePath || ""));
    if (!filePath.startsWith(`${this.store.rootDir}${path.sep}`) || !fs.existsSync(filePath)) return null;
    return { ...asset, filePath };
  }
}

function safeAssetPart(value) {
  return String(value || "asset").trim().replace(/[^a-z0-9_-]/gi, "-");
}

function normalizeExtension(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(normalized)) throw new Error("Invalid asset extension");
  return normalized;
}

module.exports = { MementoAssets };
