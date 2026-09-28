const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  XhsReaderService,
  assertAllowedXhsUrl,
  determineFrameCount,
  extractInitialState,
  extractVideoUrl,
  findNoteData,
  normalizeNoteData,
  normalizeUndefinedLiterals,
} = require("../src/services/xhs-reader");

const FIXTURES = path.join(__dirname, "fixtures", "xhs");
const PUBLIC_DNS = async () => [{ address: "1.1.1.1", family: 4 }];

test("initial-state parser replaces only bare undefined and finds primary note data", async () => {
  const html = await fs.readFile(path.join(FIXTURES, "page-primary.html"), "utf8");
  const state = extractInitialState(html);
  const note = findNoteData(state);
  const normalized = normalizeNoteData(note);

  assert.equal(note.optionalValue, null);
  assert.match(note.desc, /undefined/);
  assert.equal(normalized.note.title, "猫站长的一天");
  assert.equal(normalized.note.author.name, "灯灯");
  assert.equal(normalized.note.interactions.liked, 12);
  assert.deepEqual(normalized.imageUrls, ["https://sns-img-qc.xhscdn.com/full.webp"]);
  assert.equal(normalized.videoUrl, "https://sns-video-bd.xhscdn.com/video-1.mp4");
});

test("initial-state parser supports normalNotePreloadData fallback", async () => {
  const html = await fs.readFile(path.join(FIXTURES, "page-fallback.html"), "utf8");
  const note = findNoteData(extractInitialState(html));
  const normalized = normalizeNoteData(note);

  assert.equal(normalized.note.id, "note-image-1");
  assert.equal(normalized.note.title, "备用路径图文");
  assert.equal(normalized.note.type, "image");
  assert.deepEqual(normalized.imageUrls, ["https://sns-img-qc.xhscdn.com/fallback.jpg"]);
});

test("undefined normalizer preserves strings and identifier substrings", () => {
  const source = '{"a":undefined,"b":"undefined","c":"notundefined","d":[undefined]}';
  assert.equal(
    normalizeUndefinedLiterals(source),
    '{"a":null,"b":"undefined","c":"notundefined","d":[null]}',
  );
});

test("video URL candidates prefer h264 master and fall back to origin key", () => {
  assert.equal(extractVideoUrl({
    media: { stream: { h264: [{ masterUrl: "https://sns-video-bd.xhscdn.com/master.mp4" }] } },
    consumer: { originVideoKey: "fallback.mp4" },
  }), "https://sns-video-bd.xhscdn.com/master.mp4");
  assert.equal(extractVideoUrl({ consumer: { originVideoKey: "folder/origin.mp4" } }),
    "https://sns-video-bd.xhscdn.com/folder/origin.mp4");
});

test("URL guard rejects non-XHS hosts, IP literals, and private DNS results", async () => {
  await assert.rejects(
    assertAllowedXhsUrl("https://example.com/note", { dnsLookup: PUBLIC_DNS }),
    /outside the XHS allowlist/,
  );
  await assert.rejects(
    assertAllowedXhsUrl("http://127.0.0.1/note", { dnsLookup: PUBLIC_DNS }),
    /not allowed/,
  );
  await assert.rejects(
    assertAllowedXhsUrl("https://www.xiaohongshu.com/explore/1", {
      dnsLookup: async () => [{ address: "192.168.1.2", family: 4 }],
    }),
    /non-public address/,
  );
  const allowed = await assertAllowedXhsUrl("https://xhslink.com/a", { dnsLookup: PUBLIC_DNS });
  assert.equal(allowed.hostname, "xhslink.com");
});

test("frame count follows eight-second cadence with four-to-eight bounds", () => {
  assert.equal(determineFrameCount(5), 4);
  assert.equal(determineFrameCount(40), 5);
  assert.equal(determineFrameCount(200), 8);
});

test("service follows an allowed short link, downloads images, degrades without ffmpeg, and caches", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-xhs-cache-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const html = await fs.readFile(path.join(FIXTURES, "page-primary.html"), "utf8");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://xhslink.com/short") {
      return new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/explore/note-video-1?xsec_token=test" } });
    }
    if (url.startsWith("https://www.xiaohongshu.com/explore/")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url === "https://sns-img-qc.xhscdn.com/full.webp") {
      return new Response(Buffer.from("fake-image"), { status: 200, headers: { "content-type": "image/webp" } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const service = new XhsReaderService({
    config: { xhsCacheDir: cacheDir },
    fetchImpl,
    dnsLookup: PUBLIC_DNS,
    execFileImpl: async () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    },
  });

  const first = await service.read({ url: "https://xhslink.com/short" });
  assert.equal(first.cache.hit, false);
  assert.equal(first.note.title, "猫站长的一天");
  assert.equal(first.videoProcessing.status, "ffmpeg_unavailable");
  assert.equal(first.images.length, 1);
  assert.equal(await fs.readFile(first.images[0].absolutePath, "utf8"), "fake-image");
  assert.equal(calls[0].options.redirect, "manual");
  assert.match(calls[0].options.headers["user-agent"], /iPhone/);

  const callCountAfterFirstRead = calls.length;
  const second = await service.read({ url: "https://xhslink.com/short" });
  assert.equal(second.cache.hit, true);
  assert.equal(calls.length, callCountAfterFirstRead);

  const refreshed = await service.read({ url: "https://xhslink.com/short", refresh: true });
  assert.equal(refreshed.cache.hit, false);
  assert.ok(calls.length > callCountAfterFirstRead);
});

test("service invokes fake ffprobe/ffmpeg and returns ordered storyboard frames", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-xhs-video-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const html = await fs.readFile(path.join(FIXTURES, "page-primary.html"), "utf8");
  const execCalls = [];
  const fetchImpl = async (url) => {
    if (url.startsWith("https://www.xiaohongshu.com/")) return new Response(html, { status: 200 });
    if (url.endsWith("full.webp")) return new Response(Buffer.from("image"), { status: 200, headers: { "content-type": "image/webp" } });
    if (url.endsWith("video-1.mp4")) return new Response(Buffer.from("video"), { status: 200, headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected URL: ${url}`);
  };
  const execFileImpl = async (command, args) => {
    execCalls.push({ command, args });
    if (args.includes("-version")) return { stdout: `${command} version test` };
    if (command === "ffprobe-test") return { stdout: "40.0\n" };
    if (command === "ffmpeg-test") {
      const requested = Number(args[args.indexOf("-frames:v") + 1]);
      const pattern = args[args.length - 1];
      for (let index = 1; index <= requested; index += 1) {
        await fs.writeFile(pattern.replace("%02d", String(index).padStart(2, "0")), `frame-${index}`);
      }
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  const service = new XhsReaderService({
    config: {
      xhsCacheDir: cacheDir,
      xhsFfmpegPath: "ffmpeg-test",
      xhsFfprobePath: "ffprobe-test",
    },
    fetchImpl,
    dnsLookup: PUBLIC_DNS,
    execFileImpl,
  });

  const result = await service.read({ url: "https://www.xiaohongshu.com/explore/note-video-1" });
  assert.equal(result.videoProcessing.status, "completed");
  assert.equal(result.videoProcessing.requestedFrameCount, 5);
  assert.equal(result.videoFrames.length, 5);
  assert.deepEqual(result.videoFrames.map((frame) => frame.index), [1, 2, 3, 4, 5]);
  assert.ok(result.videoFrames.every((frame) => path.isAbsolute(frame.absolutePath)));
  const ffmpegCall = execCalls.find((call) => call.command === "ffmpeg-test" && call.args.includes("-vf"));
  assert.match(ffmpegCall.args[ffmpegCall.args.indexOf("-vf") + 1], /fps=5\/40/);
  assert.match(ffmpegCall.args[ffmpegCall.args.indexOf("-vf") + 1], /min\(960,iw\)/);
});

test("service enforces declared image size before writing it", async (t) => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberboss-xhs-limit-"));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const html = await fs.readFile(path.join(FIXTURES, "page-fallback.html"), "utf8");
  const service = new XhsReaderService({
    config: { xhsCacheDir: cacheDir, xhsImageMaxBytes: 4 },
    dnsLookup: PUBLIC_DNS,
    fetchImpl: async (url) => {
      if (url.startsWith("https://www.xiaohongshu.com/")) return new Response(html, { status: 200 });
      return new Response(Buffer.from("too-large"), { status: 200, headers: { "content-length": "9" } });
    },
  });
  await assert.rejects(
    service.read({ url: "https://www.xiaohongshu.com/explore/note-image-1" }),
    (error) => error?.code === "response_too_large",
  );
});
