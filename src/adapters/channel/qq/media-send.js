const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const OUTBOX_DIR = "outbox";
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;

async function sendQqMedia({ oneBot, config, userId, filePath, kind = "auto", caption = "", fileName = "" }) {
  const resolvedPath = path.resolve(String(filePath || ""));
  const bytes = await fs.readFile(resolvedPath);
  const resolvedName = sanitizeFileName(fileName || path.basename(resolvedPath));
  const resolvedKind = resolveQqMediaKind(kind, resolvedName);
  if (resolvedKind === "image" && bytes.length <= positiveInt(config.qqMediaBase64MaxBytes, 2 * 1024 * 1024)) {
    const message = [];
    if (String(caption || "").trim()) message.push({ type: "text", data: { text: String(caption).trim() } });
    message.push({ type: "image", data: { file: `base64://${bytes.toString("base64")}` } });
    const result = await oneBot.callAction("send_private_msg", { user_id: userId, message });
    return { result, deliveryKind: "image-base64" };
  }

  const shared = await copyToSharedOutbox({ config, sourcePath: resolvedPath, fileName: resolvedName });
  if (resolvedKind === "image") {
    const message = [];
    if (String(caption || "").trim()) message.push({ type: "text", data: { text: String(caption).trim() } });
    message.push({ type: "image", data: { file: shared.containerUri } });
    const result = await oneBot.callAction("send_private_msg", { user_id: userId, message });
    return { result, deliveryKind: "image-shared" };
  }
  if (String(caption || "").trim()) {
    await oneBot.callAction("send_private_msg", { user_id: userId, message: String(caption).trim() });
  }
  const result = await oneBot.callAction("upload_private_file", {
    user_id: userId,
    file: shared.containerUri,
    name: resolvedName,
  });
  return { result, deliveryKind: "file-shared" };
}

async function copyToSharedOutbox({ config, sourcePath, fileName }) {
  const hostRoot = String(config.qqMediaHostDir || "").trim();
  const containerRoot = String(config.qqMediaContainerDir || "").trim().replace(/\/+$/, "");
  if (!hostRoot || !containerRoot) {
    throw new Error("QQ shared media requires CYBERBOSS_QQ_MEDIA_HOST_DIR and CYBERBOSS_QQ_MEDIA_CONTAINER_DIR");
  }
  const hostOutbox = path.resolve(hostRoot, OUTBOX_DIR);
  await fs.mkdir(hostOutbox, { recursive: true });
  cleanupExpiredOutbox(hostOutbox).catch(() => {});
  const targetName = `${crypto.randomUUID()}-${sanitizeFileName(fileName)}`;
  const hostPath = path.join(hostOutbox, targetName);
  await fs.copyFile(sourcePath, hostPath);
  return {
    hostPath,
    containerUri: `file://${containerRoot}/${OUTBOX_DIR}/${targetName}`.replace(/\\/g, "/"),
  };
}

async function cleanupExpiredOutbox(directory, now = Date.now()) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath);
    if (now - stat.mtimeMs > OUTBOX_MAX_AGE_MS) await fs.unlink(filePath);
  }));
}

function resolveQqMediaKind(kind, fileName) {
  const explicit = String(kind || "").trim().toLowerCase();
  if (["image", "photo", "animation"].includes(explicit)) return "image";
  if (explicit && explicit !== "auto") return "file";
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(path.extname(fileName).toLowerCase())
    ? "image"
    : "file";
}

function sanitizeFileName(value) {
  const cleaned = String(value || "file.bin").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-");
  return cleaned.slice(0, 160) || "file.bin";
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = { cleanupExpiredOutbox, copyToSharedOutbox, resolveQqMediaKind, sendQqMedia };
