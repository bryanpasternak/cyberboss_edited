const fs = require("fs/promises");
const path = require("path");

const MAX_FILE_NAME_LENGTH = 120;

async function persistIncomingQqAttachments({
  attachments,
  stateDir,
  receivedAt = "",
  fetchImpl = globalThis.fetch,
}) {
  const saved = [];
  const failed = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    try {
      saved.push(await persistOne({ attachment, stateDir, receivedAt, fetchImpl }));
    } catch (error) {
      failed.push({
        kind: attachment?.kind || "file",
        sourceFileName: attachment?.fileName || "",
        reason: error instanceof Error ? error.message : String(error || "unknown attachment error"),
      });
    }
  }
  return { saved, failed };
}

async function persistOne({ attachment, stateDir, receivedAt, fetchImpl }) {
  const source = String(attachment?.url || attachment?.source || "").trim();
  if (!source) throw new Error("QQ attachment has no downloadable URL or Base64 data");

  let bytes;
  let serverContentType = "";
  if (source.startsWith("base64://")) {
    bytes = Buffer.from(source.slice("base64://".length), "base64");
    if (!bytes.length) throw new Error("QQ attachment contains empty Base64 data");
  } else if (/^https?:\/\//i.test(source)) {
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for QQ attachment download");
    const response = await fetchImpl(source);
    if (!response?.ok) throw new Error(`QQ attachment download failed http ${response?.status || "unknown"}`);
    bytes = Buffer.from(await response.arrayBuffer());
    serverContentType = normalizeContentType(response.headers?.get?.("content-type"));
  } else {
    throw new Error("QQ attachment is only available inside the NapCat container; enable its download URL");
  }

  const detected = detectContent(bytes);
  const contentType = detected.contentType || serverContentType || "application/octet-stream";
  const fileName = buildFileName(attachment, detected.extension || extensionFromContentType(contentType));
  const targetDir = path.join(stateDir, "inbox", normalizeDateFolder(receivedAt));
  const absolutePath = await writeUniqueFile(targetDir, fileName, bytes);
  return {
    kind: attachment?.kind || "file",
    contentType,
    isImage: contentType.startsWith("image/") || attachment?.kind === "image",
    sourceFileName: attachment?.fileName || "",
    fileName: path.basename(absolutePath),
    absolutePath,
    relativePath: path.relative(stateDir, absolutePath).replace(/\\/g, "/"),
    sizeBytes: bytes.length,
  };
}

function detectContent(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", extension: ".png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: ".jpg" };
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return { contentType: "image/gif", extension: ".gif" };
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { contentType: "image/webp", extension: ".webp" };
  }
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { contentType: "application/pdf", extension: ".pdf" };
  }
  return { contentType: "", extension: "" };
}

function buildFileName(attachment, inferredExtension) {
  const sourceName = sanitizeFileName(attachment?.fileName || "");
  if (sourceName && path.extname(sourceName)) return sourceName;
  const base = sourceName || `qq-${attachment?.itemType || attachment?.kind || "file"}-${Date.now()}`;
  return `${base}${inferredExtension || fallbackExtension(attachment?.kind)}`;
}

function sanitizeFileName(value) {
  const parsed = path.parse(String(value || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-"));
  const base = (parsed.name || "").slice(0, MAX_FILE_NAME_LENGTH);
  return base ? `${base}${parsed.ext.slice(0, 16)}` : "";
}

function fallbackExtension(kind) {
  return { image: ".jpg", video: ".mp4", voice: ".silk" }[kind] || ".bin";
}

function extensionFromContentType(contentType) {
  return {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
  }[normalizeContentType(contentType)] || "";
}

function normalizeContentType(value) {
  return typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
}

function normalizeDateFolder(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().slice(0, 10);
}

async function writeUniqueFile(targetDir, fileName, bytes) {
  await fs.mkdir(targetDir, { recursive: true });
  const parsed = path.parse(fileName);
  for (let index = 0; index < 50; index += 1) {
    const suffix = index ? `-${index + 1}` : "";
    const candidate = path.join(targetDir, `${parsed.name || "attachment"}${suffix}${parsed.ext || ""}`);
    try {
      await fs.writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error("unable to allocate a unique QQ attachment file name");
}

module.exports = { detectContent, persistIncomingQqAttachments };
