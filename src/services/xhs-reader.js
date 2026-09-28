const crypto = require("crypto");
const dns = require("dns/promises");
const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const PAGE_DOMAINS = ["xhslink.com", "xiaohongshu.com"];
const MEDIA_DOMAINS = ["xhscdn.com", "xiaohongshu.com"];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

class XhsReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XhsReaderError";
    this.code = code;
  }
}

class XhsReaderService {
  constructor({ config = {}, fetchImpl = globalThis.fetch, dnsLookup = dns.lookup, execFileImpl = execFileAsync, now = () => Date.now() } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("XhsReaderService requires fetch");
    }
    this.fetchImpl = fetchImpl;
    this.dnsLookup = dnsLookup;
    this.execFileImpl = execFileImpl;
    this.now = now;
    this.cacheDir = path.resolve(config.xhsCacheDir || path.join(config.stateDir || process.cwd(), "xhs-cache"));
    this.cacheTtlMs = positiveInt(config.xhsCacheTtlMs, 6 * 60 * 60_000);
    this.timeoutMs = positiveInt(config.xhsTimeoutMs, 60_000);
    this.maxRedirects = positiveInt(config.xhsMaxRedirects, 5);
    this.htmlMaxBytes = positiveInt(config.xhsHtmlMaxBytes, 8 * 1024 * 1024);
    this.imageMaxBytes = positiveInt(config.xhsImageMaxBytes, 25 * 1024 * 1024);
    this.videoMaxBytes = positiveInt(config.xhsVideoMaxBytes, 200 * 1024 * 1024);
    this.maxImages = positiveInt(config.xhsMaxImages, 12);
    this.ffmpegPath = normalizeText(config.xhsFfmpegPath) || "ffmpeg";
    this.ffprobePath = normalizeText(config.xhsFfprobePath) || "ffprobe";
    this.videoFrameIntervalSeconds = positiveInt(config.xhsVideoFrameIntervalSeconds, 8);
    this.videoMinFrames = positiveInt(config.xhsVideoMinFrames, 4);
    this.videoMaxFrames = positiveInt(config.xhsVideoMaxFrames, 8);
  }

  async read({ url, refresh = false } = {}) {
    const sourceUrl = normalizeInputUrl(url);
    await assertAllowedXhsUrl(sourceUrl, { kind: "page", dnsLookup: this.dnsLookup });
    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.pruneExpiredCache().catch(() => {});

    const cacheKey = crypto.createHash("sha256").update(sourceUrl).digest("hex");
    const entryDir = this.cacheEntryPath(cacheKey);
    if (!refresh) {
      const cached = await this.readCachedManifest(entryDir);
      if (cached) {
        return materializeManifest(cached, entryDir, true);
      }
    }

    const stagingDir = this.cacheEntryPath(`${cacheKey}.staging-${process.pid}-${crypto.randomUUID()}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("XHS read timed out")), this.timeoutMs);
    try {
      await fs.mkdir(stagingDir, { recursive: true });
      const page = await this.fetchWithRedirects(sourceUrl, {
        kind: "page",
        signal: controller.signal,
        headers: {
          "user-agent": MOBILE_USER_AGENT,
          "accept": "text/html,application/xhtml+xml",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.5",
        },
      });
      const html = (await readResponseBuffer(page.response, this.htmlMaxBytes)).toString("utf8");
      const state = extractInitialState(html);
      const noteData = findNoteData(state);
      if (!noteData) {
        throw new XhsReaderError("note_not_found", "XHS page did not contain a recognizable note object");
      }
      const normalized = normalizeNoteData(noteData);
      const images = await this.downloadImages(normalized.imageUrls, stagingDir, controller.signal);
      const videoResult = await this.processVideo(normalized.videoUrl, stagingDir, controller.signal);
      const fetchedAtMs = this.now();
      const manifest = {
        version: 1,
        sourceUrl,
        finalUrl: page.finalUrl,
        fetchedAt: new Date(fetchedAtMs).toISOString(),
        expiresAt: new Date(fetchedAtMs + this.cacheTtlMs).toISOString(),
        note: normalized.note,
        images,
        video: {
          available: Boolean(normalized.videoUrl),
          coverUrl: normalized.videoCoverUrl || normalized.imageUrls[0] || "",
        },
        videoFrames: videoResult.frames,
        videoProcessing: videoResult.processing,
      };
      await fs.writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await this.replaceCacheEntry(stagingDir, entryDir);
      return materializeManifest(manifest, entryDir, false);
    } catch (error) {
      await this.removeCachePath(stagingDir).catch(() => {});
      if (error?.name === "AbortError") {
        throw new XhsReaderError("timeout", `XHS read exceeded ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchWithRedirects(rawUrl, { kind, signal, headers }) {
    let currentUrl = await assertAllowedXhsUrl(rawUrl, { kind, dnsLookup: this.dnsLookup });
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const response = await this.fetchImpl(currentUrl.href, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects === this.maxRedirects) {
          throw new XhsReaderError("too_many_redirects", `XHS request exceeded ${this.maxRedirects} redirects`);
        }
        const location = normalizeText(response.headers?.get?.("location"));
        if (!location) {
          throw new XhsReaderError("invalid_redirect", "XHS redirect response did not include Location");
        }
        currentUrl = await assertAllowedXhsUrl(new URL(location, currentUrl).href, {
          kind,
          dnsLookup: this.dnsLookup,
        });
        continue;
      }
      if (!response.ok) {
        throw new XhsReaderError("http_error", `XHS request failed with HTTP ${response.status}`);
      }
      return { response, finalUrl: currentUrl.href };
    }
    throw new XhsReaderError("too_many_redirects", "XHS redirect limit exceeded");
  }

  async downloadImages(imageUrls, stagingDir, signal) {
    const output = [];
    const selected = [...new Set(imageUrls.map(normalizeText).filter(Boolean))].slice(0, this.maxImages);
    for (let index = 0; index < selected.length; index += 1) {
      const remoteUrl = selected[index];
      const extension = inferImageExtension(remoteUrl);
      const relativePath = path.posix.join("images", `image-${String(index + 1).padStart(2, "0")}${extension}`);
      const destination = path.join(stagingDir, ...relativePath.split("/"));
      const downloaded = await this.downloadToFile(remoteUrl, destination, {
        kind: "media",
        maxBytes: this.imageMaxBytes,
        signal,
        headers: {
          "user-agent": MOBILE_USER_AGENT,
          "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      output.push({
        index: index + 1,
        url: remoteUrl,
        relativePath,
        contentType: downloaded.contentType,
        bytes: downloaded.bytes,
      });
    }
    return output;
  }

  async processVideo(videoUrl, stagingDir, signal) {
    if (!videoUrl) {
      return { frames: [], processing: { status: "not_applicable" } };
    }
    const binariesAvailable = await this.videoBinariesAvailable(signal);
    if (!binariesAvailable) {
      return {
        frames: [],
        processing: {
          status: "ffmpeg_unavailable",
          requiredCommands: [this.ffmpegPath, this.ffprobePath],
        },
      };
    }

    const relativeVideoPath = path.posix.join("video", "source.mp4");
    const videoPath = path.join(stagingDir, ...relativeVideoPath.split("/"));
    try {
      const downloaded = await this.downloadToFile(videoUrl, videoPath, {
        kind: "media",
        maxBytes: this.videoMaxBytes,
        signal,
        headers: {
          "user-agent": MOBILE_USER_AGENT,
          "accept": "video/mp4,video/*;q=0.9,*/*;q=0.5",
        },
      });
      const probe = await this.execFileImpl(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "csv=p=0",
        videoPath,
      ], { encoding: "utf8", maxBuffer: 1024 * 1024, signal });
      const durationSeconds = Number.parseFloat(String(probe?.stdout || "").trim());
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new XhsReaderError("invalid_video_duration", "ffprobe returned an invalid video duration");
      }
      const frameCount = determineFrameCount(durationSeconds, {
        intervalSeconds: this.videoFrameIntervalSeconds,
        minFrames: this.videoMinFrames,
        maxFrames: this.videoMaxFrames,
      });
      const framesDir = path.join(stagingDir, "frames");
      await fs.mkdir(framesDir, { recursive: true });
      const framePattern = path.join(framesDir, "frame-%02d.jpg");
      const filter = `fps=${frameCount}/${formatDecimal(durationSeconds)},scale='min(960,iw)':-2`;
      await this.execFileImpl(this.ffmpegPath, [
        "-y", "-v", "error",
        "-i", videoPath,
        "-vf", filter,
        "-frames:v", String(frameCount),
        "-q:v", "4",
        framePattern,
      ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal });
      const frameNames = (await fs.readdir(framesDir))
        .filter((name) => /^frame-\d+\.jpg$/i.test(name))
        .sort((left, right) => left.localeCompare(right, "en"));
      if (!frameNames.length) {
        throw new XhsReaderError("no_video_frames", "ffmpeg completed without producing frames");
      }
      const frames = frameNames.map((name, index) => ({
        index: index + 1,
        timestampSeconds: roundToMillis(((index + 0.5) * durationSeconds) / frameNames.length),
        relativePath: path.posix.join("frames", name),
      }));
      return {
        frames,
        processing: {
          status: "completed",
          durationSeconds: roundToMillis(durationSeconds),
          requestedFrameCount: frameCount,
          producedFrameCount: frames.length,
          sourceBytes: downloaded.bytes,
          audioAnalyzed: false,
        },
      };
    } catch (error) {
      if (error instanceof XhsReaderError && error.code === "response_too_large") {
        return {
          frames: [],
          processing: {
            status: "video_too_large",
            maxBytes: this.videoMaxBytes,
          },
        };
      }
      return {
        frames: [],
        processing: {
          status: "video_processing_failed",
          reason: safeErrorMessage(error),
        },
      };
    }
  }

  async videoBinariesAvailable(signal) {
    try {
      await this.execFileImpl(this.ffprobePath, ["-version"], { encoding: "utf8", maxBuffer: 1024 * 1024, signal });
      await this.execFileImpl(this.ffmpegPath, ["-version"], { encoding: "utf8", maxBuffer: 1024 * 1024, signal });
      return true;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "UNKNOWN") {
        return false;
      }
      return false;
    }
  }

  async downloadToFile(remoteUrl, destination, { kind, maxBytes, signal, headers }) {
    const fetched = await this.fetchWithRedirects(remoteUrl, { kind, signal, headers });
    const contentLength = parseContentLength(fetched.response.headers?.get?.("content-length"));
    if (contentLength > maxBytes) {
      throw new XhsReaderError("response_too_large", `Remote resource exceeds ${maxBytes} bytes`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.part-${crypto.randomUUID()}`;
    let handle;
    let bytes = 0;
    try {
      handle = await fs.open(temporaryPath, "wx");
      if (fetched.response.body) {
        for await (const rawChunk of fetched.response.body) {
          const chunk = Buffer.from(rawChunk);
          bytes += chunk.length;
          if (bytes > maxBytes) {
            throw new XhsReaderError("response_too_large", `Remote resource exceeds ${maxBytes} bytes`);
          }
          await handle.write(chunk);
        }
      } else {
        const buffer = Buffer.from(await fetched.response.arrayBuffer());
        bytes = buffer.length;
        if (bytes > maxBytes) {
          throw new XhsReaderError("response_too_large", `Remote resource exceeds ${maxBytes} bytes`);
        }
        await handle.write(buffer);
      }
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, destination);
      return {
        bytes,
        contentType: normalizeText(fetched.response.headers?.get?.("content-type")).split(";")[0],
        finalUrl: fetched.finalUrl,
      };
    } catch (error) {
      await handle?.close?.().catch(() => {});
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async readCachedManifest(entryDir) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(entryDir, "manifest.json"), "utf8"));
      const expiresAt = Date.parse(manifest.expiresAt || "");
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
        await this.removeCachePath(entryDir);
        return null;
      }
      const relativePaths = [
        ...(manifest.images || []).map((item) => item.relativePath),
        ...(manifest.videoFrames || []).map((item) => item.relativePath),
      ];
      for (const relativePath of relativePaths) {
        const absolutePath = resolveRelativeCachePath(entryDir, relativePath);
        await fs.access(absolutePath);
      }
      return manifest;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this.removeCachePath(entryDir).catch(() => {});
      }
      return null;
    }
  }

  async replaceCacheEntry(stagingDir, entryDir) {
    await this.removeCachePath(entryDir).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rename(stagingDir, entryDir);
  }

  async pruneExpiredCache() {
    const entries = await fs.readdir(this.cacheDir, { withFileTypes: true });
    const limited = entries.filter((entry) => entry.isDirectory()).slice(0, 100);
    for (const entry of limited) {
      const entryPath = this.cacheEntryPath(entry.name);
      if (entry.name.includes(".staging-")) {
        const stats = await fs.stat(entryPath).catch(() => null);
        if (stats && stats.mtimeMs + this.timeoutMs * 2 < this.now()) {
          await this.removeCachePath(entryPath);
        }
        continue;
      }
      const manifest = await fs.readFile(path.join(entryPath, "manifest.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      if (!manifest || Date.parse(manifest.expiresAt || "") <= this.now()) {
        await this.removeCachePath(entryPath);
      }
    }
  }

  cacheEntryPath(name) {
    const candidate = path.resolve(this.cacheDir, name);
    assertPathInside(this.cacheDir, candidate);
    return candidate;
  }

  async removeCachePath(candidate) {
    const resolved = path.resolve(candidate);
    assertPathInside(this.cacheDir, resolved);
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

function extractInitialState(html) {
  const text = String(html || "");
  const markers = ["window.__INITIAL_STATE__", "__INITIAL_STATE__"];
  for (const marker of markers) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const markerIndex = text.indexOf(marker, searchFrom);
      if (markerIndex < 0) break;
      const assignmentIndex = text.indexOf("=", markerIndex + marker.length);
      if (assignmentIndex < 0 || assignmentIndex - markerIndex > 128) break;
      const objectStart = text.indexOf("{", assignmentIndex + 1);
      if (objectStart < 0 || objectStart - assignmentIndex > 256) {
        searchFrom = markerIndex + marker.length;
        continue;
      }
      const objectText = scanBalancedObject(text, objectStart);
      if (objectText) {
        try {
          return JSON.parse(normalizeUndefinedLiterals(objectText));
        } catch (error) {
          throw new XhsReaderError("invalid_initial_state", `XHS initial state is not valid JSON: ${safeErrorMessage(error)}`);
        }
      }
      searchFrom = markerIndex + marker.length;
    }
  }
  throw new XhsReaderError("initial_state_not_found", "XHS page did not contain window.__INITIAL_STATE__");
}

function scanBalancedObject(text, startIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(startIndex, index + 1);
    }
  }
  return "";
}

function normalizeUndefinedLiterals(text) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    if (text.startsWith("undefined", index)
      && !isIdentifierChar(text[index - 1])
      && !isIdentifierChar(text[index + "undefined".length])) {
      output += "null";
      index += "undefined".length - 1;
      continue;
    }
    output += char;
  }
  return output;
}

function findNoteData(state) {
  const directCandidates = [
    state?.noteData?.data?.noteData,
    state?.noteData?.data?.normalNotePreloadData?.noteData,
    state?.noteData?.data?.normalNotePreloadData,
    state?.noteData?.noteData,
    state?.note?.noteData,
  ];
  for (const candidate of directCandidates) {
    if (looksLikeNote(candidate)) return candidate;
  }
  const detailMap = state?.note?.noteDetailMap || state?.noteData?.data?.noteDetailMap;
  if (detailMap && typeof detailMap === "object") {
    for (const value of Object.values(detailMap)) {
      for (const candidate of [value?.note, value?.noteData, value]) {
        if (looksLikeNote(candidate)) return candidate;
      }
    }
  }
  return findNoteBreadthFirst(state);
}

function findNoteBreadthFirst(root) {
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  let visited = 0;
  while (queue.length && visited < 2000) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (looksLikeNote(value)) return value;
    if (depth >= 7) continue;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function looksLikeNote(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hasText = Boolean(normalizeText(value.title || value.displayTitle || value.desc || value.description));
  const hasMedia = Array.isArray(value.imageList) || Array.isArray(value.images) || Boolean(value.video);
  return hasText && hasMedia;
}

function normalizeNoteData(noteData) {
  const user = noteData.user || noteData.userInfo || noteData.author || {};
  const interact = noteData.interactInfo || noteData.interactionInfo || {};
  const imageUrls = extractImageUrls(noteData.imageList || noteData.images || []);
  const videoUrl = extractVideoUrl(noteData.video);
  const videoCoverUrl = extractVideoCoverUrl(noteData.video);
  if (videoCoverUrl && !imageUrls.includes(videoCoverUrl)) imageUrls.unshift(videoCoverUrl);
  return {
    note: {
      id: normalizeText(noteData.noteId || noteData.id),
      title: normalizeText(noteData.title || noteData.displayTitle),
      text: normalizeText(noteData.desc || noteData.description || noteData.content),
      type: videoUrl ? "video" : "image",
      author: {
        id: normalizeText(user.userId || user.id || user.redId),
        name: normalizeText(user.nickname || user.nickName || user.name),
        avatarUrl: firstText(user.image, user.avatar, user.avatarUrl),
      },
      interactions: {
        liked: normalizeCount(interact.likedCount ?? interact.likeCount),
        collected: normalizeCount(interact.collectedCount ?? interact.collectCount),
        comments: normalizeCount(interact.commentCount ?? interact.commentsCount),
        shared: normalizeCount(interact.shareCount ?? interact.sharedCount),
      },
    },
    imageUrls,
    videoUrl,
    videoCoverUrl,
  };
}

function extractImageUrls(imageList) {
  const urls = [];
  for (const image of Array.isArray(imageList) ? imageList : []) {
    const infoList = Array.isArray(image?.infoList) ? image.infoList : [];
    const preferred = infoList.find((item) => item?.imageScene === "WB_DFT")
      || infoList.find((item) => item?.imageScene === "WB_PRV")
      || infoList[0];
    const remoteUrl = firstText(
      preferred?.url,
      preferred?.urlDefault,
      image?.urlDefault,
      image?.urlPre,
      image?.url,
    );
    if (remoteUrl && !urls.includes(remoteUrl)) urls.push(remoteUrl);
  }
  return urls;
}

function extractVideoUrl(video) {
  if (!video || typeof video !== "object") return "";
  const streams = video.media?.stream || {};
  for (const codec of ["h264", "h265", "av1"]) {
    const candidates = Array.isArray(streams[codec]) ? streams[codec] : [streams[codec]].filter(Boolean);
    for (const candidate of candidates) {
      const direct = firstText(candidate?.masterUrl, candidate?.url);
      if (direct) return direct;
      const backup = Array.isArray(candidate?.backupUrls) ? firstText(...candidate.backupUrls) : "";
      if (backup) return backup;
    }
  }
  const originKey = normalizeText(video.consumer?.originVideoKey);
  if (originKey && !originKey.includes("..") && !originKey.includes(":")) {
    return `https://sns-video-bd.xhscdn.com/${originKey.replace(/^\/+/, "")}`;
  }
  return firstText(video.url, video.masterUrl);
}

function extractVideoCoverUrl(video) {
  return firstText(
    video?.cover?.url,
    video?.cover?.urlDefault,
    video?.image?.url,
    video?.image?.urlDefault,
    video?.firstFrame?.url,
  );
}

async function assertAllowedXhsUrl(rawUrl, { kind = "page", dnsLookup = dns.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw new XhsReaderError("invalid_url", "XHS URL is invalid");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new XhsReaderError("invalid_protocol", "XHS URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new XhsReaderError("credentials_in_url", "XHS URL must not contain credentials");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || net.isIP(hostname)) {
    throw new XhsReaderError("blocked_host", "XHS URL host is not allowed");
  }
  const allowedDomains = kind === "media" ? MEDIA_DOMAINS : PAGE_DOMAINS;
  if (!allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new XhsReaderError("blocked_host", `Host ${hostname} is outside the XHS allowlist`);
  }
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new XhsReaderError("dns_failed", `Could not resolve ${hostname}: ${safeErrorMessage(error)}`);
  }
  const records = Array.isArray(addresses) ? addresses : [addresses];
  if (!records.length || records.some((record) => !isPublicIp(record?.address || record))) {
    throw new XhsReaderError("blocked_address", `Host ${hostname} resolved to a non-public address`);
  }
  return parsed;
}

function isPublicIp(address) {
  const value = normalizeText(address).toLowerCase();
  const family = net.isIP(value);
  if (family === 4) {
    const parts = value.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if ((a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family === 6) {
    if (value === "::" || value === "::1") return false;
    if (/^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith("ff")) return false;
    if (value.startsWith("2001:db8")) return false;
    const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

async function readResponseBuffer(response, maxBytes) {
  const contentLength = parseContentLength(response.headers?.get?.("content-length"));
  if (contentLength > maxBytes) {
    throw new XhsReaderError("response_too_large", `XHS HTML exceeds ${maxBytes} bytes`);
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      bytes += chunk.length;
      if (bytes > maxBytes) {
        throw new XhsReaderError("response_too_large", `XHS HTML exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length > maxBytes) {
      throw new XhsReaderError("response_too_large", `XHS HTML exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function materializeManifest(manifest, entryDir, hit) {
  return {
    sourceUrl: manifest.sourceUrl,
    finalUrl: manifest.finalUrl,
    fetchedAt: manifest.fetchedAt,
    note: manifest.note,
    images: (manifest.images || []).map(({ relativePath, ...item }) => ({
      ...item,
      absolutePath: resolveRelativeCachePath(entryDir, relativePath),
    })),
    video: manifest.video || { available: false, coverUrl: "" },
    videoFrames: (manifest.videoFrames || []).map(({ relativePath, ...item }) => ({
      ...item,
      absolutePath: resolveRelativeCachePath(entryDir, relativePath),
    })),
    videoProcessing: manifest.videoProcessing || { status: "not_applicable" },
    cache: {
      hit,
      expiresAt: manifest.expiresAt,
      directory: entryDir,
    },
  };
}

function resolveRelativeCachePath(entryDir, relativePath) {
  const normalized = normalizeText(relativePath).replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new XhsReaderError("invalid_cache_path", "Cached media path is invalid");
  }
  const resolved = path.resolve(entryDir, ...normalized.split("/"));
  assertPathInside(entryDir, resolved);
  return resolved;
}

function assertPathInside(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    if (normalizedCandidate !== normalizedRoot) {
      throw new XhsReaderError("unsafe_cache_path", "Refusing filesystem access outside the XHS cache root");
    }
  }
}

function determineFrameCount(durationSeconds, { intervalSeconds = 8, minFrames = 4, maxFrames = 8 } = {}) {
  const estimated = Math.ceil(Number(durationSeconds) / Math.max(1, Number(intervalSeconds) || 8));
  return Math.min(Math.max(estimated, minFrames), Math.max(minFrames, maxFrames));
}

function normalizeInputUrl(value) {
  const text = normalizeText(value);
  if (!text) throw new XhsReaderError("url_required", "XHS URL is required");
  if (/^(?:[a-z0-9-]+\.)*(?:xhslink|xiaohongshu)\.com\//i.test(text)) {
    return `https://${text}`;
  }
  return text;
}

function inferImageExtension(remoteUrl) {
  try {
    const extension = path.extname(new URL(remoteUrl).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].includes(extension)) return extension;
  } catch {
    // URL validation reports the useful error later.
  }
  return ".jpg";
}

function normalizeCount(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = normalizeText(value);
  if (!text) return 0;
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : text;
}

function parseContentLength(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function firstText(...values) {
  return values.map(normalizeText).find(Boolean) || "";
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function roundToMillis(value) {
  return Math.round(value * 1000) / 1000;
}

function formatDecimal(value) {
  return String(roundToMillis(value));
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "unknown error");
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function isIdentifierChar(value) {
  return typeof value === "string" && /[A-Za-z0-9_$]/.test(value);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MOBILE_USER_AGENT,
  XhsReaderError,
  XhsReaderService,
  assertAllowedXhsUrl,
  determineFrameCount,
  extractImageUrls,
  extractInitialState,
  extractVideoUrl,
  findNoteData,
  isPublicIp,
  normalizeNoteData,
  normalizeUndefinedLiterals,
};
