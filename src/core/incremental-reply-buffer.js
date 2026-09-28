const DEFAULT_TARGET_BYTES = 3800;
const DEFAULT_HARD_MAX_BYTES = 4096;
const DEFAULT_CARRY_BYTES = 128;

class IncrementalReplyBuffer {
  constructor({
    targetBytes = DEFAULT_TARGET_BYTES,
    hardMaxBytes = DEFAULT_HARD_MAX_BYTES,
    carryBytes = DEFAULT_CARRY_BYTES,
  } = {}) {
    this.hardMaxBytes = normalizePositiveInt(hardMaxBytes, DEFAULT_HARD_MAX_BYTES);
    this.targetBytes = Math.min(
      normalizePositiveInt(targetBytes, DEFAULT_TARGET_BYTES),
      this.hardMaxBytes,
    );
    this.carryBytes = Math.min(
      normalizeNonNegativeInt(carryBytes, DEFAULT_CARRY_BYTES),
      this.hardMaxBytes,
    );
    this.streamText = "";
    this.committedRawLength = 0;
    this.sequence = 0;
    this.pendingCommit = null;
    this.hadEarlyCommit = false;
    this.finalized = false;
    this.finalResult = null;
  }

  append(text) {
    if (this.finalized) return this.streamText;
    this.streamText = appendStreamingText(this.streamText, text);
    return this.streamText;
  }

  peekReadyChunk() {
    if (this.finalized) return null;
    if (this.pendingCommit) return { ...this.pendingCommit };

    const remaining = this.streamText.slice(this.committedRawLength);
    if (!remaining || looksLikeStructuredReplyStart(remaining)) return null;

    const safeText = resolveStreamingSafePrefix(remaining, this.carryBytes);
    if (Buffer.byteLength(safeText, "utf8") < this.targetBytes) return null;

    const cutLength = findStreamingCutLength(safeText, {
      targetBytes: this.targetBytes,
      hardMaxBytes: this.hardMaxBytes,
    });
    if (!cutLength) return null;

    const rawText = safeText.slice(0, cutLength);
    const token = `${this.sequence + 1}:${this.committedRawLength}:${this.committedRawLength + rawText.length}`;
    this.pendingCommit = {
      token,
      sequence: this.sequence + 1,
      rawText,
      byteLength: Buffer.byteLength(rawText, "utf8"),
    };
    return { ...this.pendingCommit };
  }

  commit(token) {
    if (!this.pendingCommit || token !== this.pendingCommit.token) return false;
    this.committedRawLength += this.pendingCommit.rawText.length;
    this.sequence = this.pendingCommit.sequence;
    this.pendingCommit = null;
    this.hadEarlyCommit = true;
    return true;
  }

  reject(token) {
    if (!this.pendingCommit || token !== this.pendingCommit.token) return false;
    this.pendingCommit = null;
    return true;
  }

  finalize(finalText) {
    if (this.finalResult) return { ...this.finalResult };
    if (this.pendingCommit) {
      throw new Error("cannot finalize incremental reply with a pending commit");
    }

    const normalizedFinal = String(finalText || "");
    const committedPrefix = this.streamText.slice(0, this.committedRawLength);
    let mismatch = false;

    if (!this.hadEarlyCommit) {
      this.streamText = normalizedFinal || this.streamText;
    } else if (normalizedFinal && normalizedFinal.startsWith(committedPrefix)) {
      this.streamText = normalizedFinal;
    } else if (normalizedFinal && normalizedFinal !== this.streamText) {
      mismatch = true;
    }

    this.finalized = true;
    this.finalResult = {
      text: this.streamText.slice(this.committedRawLength),
      mismatch,
      hadEarlyCommit: this.hadEarlyCommit,
      committedRawLength: this.committedRawLength,
    };
    return { ...this.finalResult };
  }
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) return base;
  if (!base) return incoming;
  if (base.endsWith(incoming)) return base;
  if (incoming.startsWith(base)) return incoming;

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }
  return `${base}${incoming}`;
}

function resolveStreamingSafePrefix(text, carryBytes) {
  const normalized = String(text || "");
  if (!normalized) return "";
  const totalBytes = Buffer.byteLength(normalized, "utf8");
  const availableBytes = Math.max(0, totalBytes - Math.max(0, carryBytes));
  let safe = sliceUtf8(normalized, availableBytes);
  const unsafeIndex = findUnsafeTailIndex(safe);
  if (unsafeIndex >= 0) safe = safe.slice(0, unsafeIndex);
  return safe;
}

function findUnsafeTailIndex(text) {
  const candidates = [
    String(text || "").indexOf("<!--"),
    String(text || "").indexOf("```"),
  ].filter((index) => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function looksLikeStructuredReplyStart(text) {
  const normalized = String(text || "").trimStart();
  if (!normalized) return false;
  return normalized.startsWith("{")
    || /^json\s*:/i.test(normalized)
    || /^```(?:json)?\b/i.test(normalized)
    || /^(?:analysis|commentary|final)\s+to=/i.test(normalized);
}

function findStreamingCutLength(text, { targetBytes, hardMaxBytes } = {}) {
  const normalized = String(text || "");
  if (!normalized) return 0;
  const target = normalizePositiveInt(targetBytes, DEFAULT_TARGET_BYTES);
  const hardMax = Math.max(target, normalizePositiveInt(hardMaxBytes, DEFAULT_HARD_MAX_BYTES));
  const targetSlice = sliceUtf8(normalized, target);
  const naturalCut = findLastNaturalBoundary(targetSlice);
  if (naturalCut > 0 && Buffer.byteLength(targetSlice.slice(0, naturalCut), "utf8") >= Math.floor(target * 0.6)) {
    return naturalCut;
  }
  if (Buffer.byteLength(normalized, "utf8") >= hardMax) {
    return sliceUtf8(normalized, hardMax).length;
  }
  return 0;
}

function findLastNaturalBoundary(text) {
  const source = String(text || "");
  const pattern = /\n{2,}|\n|[。！？!?](?:["'”’）】》」』]*)\s*|[.!?](?:["'”’)\]}]*)\s+/gu;
  let cut = 0;
  for (const match of source.matchAll(pattern)) {
    cut = match.index + match[0].length;
  }
  return cut;
}

function sliceUtf8(text, maxBytes) {
  const normalized = String(text || "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  let bytes = 0;
  let end = 0;
  for (const char of normalized) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > limit) break;
    bytes += charBytes;
    end += char.length;
  }
  return normalized.slice(0, end);
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

module.exports = {
  DEFAULT_CARRY_BYTES,
  DEFAULT_HARD_MAX_BYTES,
  DEFAULT_TARGET_BYTES,
  IncrementalReplyBuffer,
  appendStreamingText,
  findStreamingCutLength,
  looksLikeStructuredReplyStart,
  sliceUtf8,
};
