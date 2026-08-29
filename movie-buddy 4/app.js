const movie = document.querySelector("#movie");
const movieInput = document.querySelector("#movieInput");
const subtitleInput = document.querySelector("#subtitleInput");
const subtitleEl = document.querySelector("#subtitle");
const emptyState = document.querySelector("#emptyState");
const conversation = document.querySelector("#conversation");
const messageInput = document.querySelector("#message");
const micButton = document.querySelector("#mic");
const micLabel = document.querySelector("#micLabel");
const hint = document.querySelector("#hint");
const stateWrap = document.querySelector(".bridge-state");
const stateText = document.querySelector("#stateText");
const buddyOverlay = document.querySelector("#buddyOverlay");
const liveContext = document.querySelector("#liveContext");
const canvas = document.querySelector("#frameCanvas");
const pageTitle = document.querySelector("#pageTitle");
const metaTime = document.querySelector("#metaTime");
const metaSubtitle = document.querySelector("#metaSubtitle");
const hardSubtitleButton = document.querySelector("#hardSubtitle");
const proactiveEnabled = document.querySelector("#proactiveEnabled");
const proactiveRate = document.querySelector("#proactiveRate");

let movieUrl = null;
let movieName = "";
let cues = [];
let mediaRecorder = null;
let recordingStream = null;
let audioChunks = [];
let recordingTimer = null;
let pendingMoment = null;
let lastResponseId = null;
let overlayTimer = null;
const pendingMoments = new Map();
let hardSubtitleMode = false;
let bridgeStatus = "starting";
let nextProactiveAt = Infinity;
let lastUserMessageAt = 0;

// Filled in from GET /api/config at boot. Everything user-visible lives here so
// the repository can stay language-neutral while a local config.json overrides it.
const settings = {
  userName: "You",
  buddyName: "Buddy",
  backend: "claude",
  capture: { maxWidth: 960, jpegQuality: 0.8 },
  ui: {},
};

function t(key, fallback) {
  const raw = settings.ui[key];
  return String(raw === undefined || raw === "" ? fallback : raw)
    .replaceAll("{buddyName}", settings.buddyName)
    .replaceAll("{userName}", settings.userName)
    .replaceAll("{backend}", settings.backend);
}

function setText(selector, key, fallback) {
  const node = document.querySelector(selector);
  if (node) node.textContent = t(key, fallback);
}

async function applyConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    Object.assign(settings, await response.json());
    settings.ui = settings.ui || {};
    settings.capture = { maxWidth: 960, jpegQuality: 0.8, ...(settings.capture || {}) };
  } catch {
    // Defaults are fine; the state poller will surface the connection problem.
  }

  document.title = settings.appTitle || "Movie Buddy";
  document.querySelector("#brandName").textContent = settings.appTitle || "Movie Buddy";
  document.querySelector("#tagline").textContent = settings.tagline || "";
  document.querySelector("#avatar").textContent = (settings.buddyName || "B").slice(0, 1).toUpperCase();

  setText("#pageTitle", "titlePlaceholder", "What are we watching tonight?");
  setText("#metaLocal", "metaLocal", "Local file");
  setText("#metaSafe", "metaSafe", "current frame only");
  setText("#companionTitle", "companionTitle", "Watch-along");
  setText("#companionSubtitle", "companionSubtitle", "what we said at each moment");
  setText("#colTime", "colTime", "Time");
  setText("#colMessage", "colMessage", "Message");
  setText("#emptyTitle", "emptyTitle", "Drop a film in here");
  setText("#emptySubtitle", "emptySubtitle", "The film plays only in this browser tab.");
  setText("#chooseMovie", "chooseMovie", "Choose a local film");
  setText("#send", "send", "Send");
  setText("#micLabel", "micIdle", "Talk");
  setText("#hint", "hintDefault", "Click again when you're done; the current frame is sent with your voice.");
  setText("#labelMovie", "labelMovie", "Film");
  setText("#labelSubtitle", "labelSubtitle", "Subtitles");
  setText("#labelProactive", "labelProactive", "Proactive");
  setText("#movieName", "labelNone", "none");
  setText("#subtitleName", "labelNone", "none");
  setText("#hardSubtitle", "hardSubtitleOff", "Subtitles are in the picture");
  setText("#privacyNote", "privacyNote", "Local playback · only the current frame and already-played subtitles are sent");
  setText("#metaSubtitle", "subtitlesNone", "No subtitles loaded");
  setText("#liveContext", "subtitlesNone", "No subtitles loaded");
  messageInput.placeholder = t("composerPlaceholder", "Say something about this moment…");

  const seed = document.querySelector("#seedMessage");
  if (seed) {
    seed.querySelector("b").textContent = settings.buddyName;
    seed.querySelector("b").nextSibling.textContent = t("seedMessage", "Load a film and I'll take the seat next to you.");
  }

  const rateOptions = ["rateRare", "rateNatural", "rateChatty"];
  const rateFallbacks = ["Rarely", "Natural", "Chatty"];
  [...proactiveRate.options].forEach((option, index) => {
    if (rateOptions[index]) option.textContent = t(rateOptions[index], rateFallbacks[index]);
  });

  const proactive = settings.proactive || {};
  if (proactive.enabled) proactiveEnabled.checked = true;
  if (proactive.intervalSeconds) {
    const match = [...proactiveRate.options].find((option) => Number(option.value) === Number(proactive.intervalSeconds));
    if (match) proactiveRate.value = match.value;
  }
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function parseTimestamp(value) {
  const clean = value.trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(clean) || 0;
}

function parseSubtitles(source) {
  const text = source.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocks = text.replace(/^WEBVTT[^\n]*\n+/, "").split(/\n{2,}/);
  return blocks.flatMap((block) => {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    const endToken = endRaw.trim().split(/\s+/)[0];
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!text) return [];
    return [{ start: parseTimestamp(startRaw), end: parseTimestamp(endToken), text }];
  }).sort((a, b) => a.start - b.start);
}

// The spoiler guarantee is structural, not a prompt: only cues whose start time
// has already passed are ever eligible to leave this function.
function subtitleMoment(time = movie.currentTime) {
  const played = cues.filter((cue) => cue.start <= time);
  const current = [...played].reverse().find((cue) => cue.end >= time) || null;
  return {
    currentSubtitle: current?.text || (hardSubtitleMode ? settings.hardSubtitlePlaceholder || "" : ""),
    recentSubtitles: played.slice(-4).map((cue) => cue.text),
  };
}

function updateSubtitle() {
  const moment = subtitleMoment();
  subtitleEl.textContent = hardSubtitleMode ? "" : moment.currentSubtitle;
  liveContext.textContent = hardSubtitleMode
    ? t("hardSubtitleLive", "Burned-in subtitles · read from the current frame")
    : (moment.currentSubtitle || (cues.length ? t("noDialogue", "no dialogue right now") : t("subtitlesNone", "No subtitles loaded")));
  metaTime.textContent = formatTime(movie.currentTime);
}

function captureMoment() {
  const context = subtitleMoment();
  let frame = "";
  if (movie.readyState >= 2 && movie.videoWidth && movie.videoHeight) {
    const width = Math.min(Number(settings.capture.maxWidth) || 960, movie.videoWidth);
    const height = Math.round(width * movie.videoHeight / movie.videoWidth);
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(movie, 0, 0, width, height);
    frame = canvas.toDataURL("image/jpeg", Number(settings.capture.jpegQuality) || 0.8);
  }
  return {
    frame,
    movie: movieName,
    timestamp: formatTime(movie.currentTime),
    timeSeconds: movie.currentTime,
    ...context,
  };
}

function addTimelineMessage(kind, text, seconds = movie.currentTime) {
  const row = document.createElement("button");
  row.className = `timeline-message ${kind}`;
  row.dataset.seconds = String(Number(seconds) || 0);
  const time = document.createElement("time");
  time.textContent = formatTime(seconds).slice(3);
  const content = document.createElement("span");
  const sender = document.createElement("b");
  sender.textContent = kind === "buddy" ? settings.buddyName : settings.userName;
  content.append(sender, document.createTextNode(text));
  row.append(time, content);
  row.addEventListener("click", () => {
    if (!movie.src) return;
    movie.currentTime = Number(row.dataset.seconds) || 0;
    movie.play().catch(() => {});
  });
  conversation.appendChild(row);
  conversation.scrollTop = conversation.scrollHeight;
}

function showBuddyOverlay(text) {
  buddyOverlay.textContent = text;
  buddyOverlay.classList.add("show");
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => buddyOverlay.classList.remove("show"), 9000);
}

async function postMessage(text, moment = captureMoment(), options = {}) {
  const clean = text.trim();
  if (!clean) return;
  if (!options.proactive) {
    addTimelineMessage("user", clean, moment.timeSeconds);
    messageInput.value = "";
    hint.textContent = t("hintSent", "This frame and what you said are on their way to {buddyName}…");
    lastUserMessageAt = Date.now();
    scheduleNextProactive();
  }
  const response = await fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: clean, mode: options.proactive ? "proactive" : "user", ...moment }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || t("sendFailed", "Could not send that"));
  pendingMoments.set(result.id, moment);
}

function proactiveInterval() {
  return Number(proactiveRate.value) || 75;
}

function scheduleNextProactive(delay = proactiveInterval()) {
  nextProactiveAt = movie.currentTime + delay;
}

function maybeSendProactive() {
  if (!proactiveEnabled.checked || movie.paused || movie.ended) return;
  if (bridgeStatus !== "ready" || movie.currentTime < nextProactiveAt) return;
  if (Date.now() - lastUserMessageAt < 30000) {
    scheduleNextProactive(35);
    return;
  }
  scheduleNextProactive();
  postMessage(t("proactivePing", "Look at what is on screen right now."), captureMoment(), { proactive: true })
    .catch((error) => { hint.textContent = error.message; });
}

async function startRecording() {
  recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferred = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  mediaRecorder = new MediaRecorder(recordingStream, { mimeType: preferred });
  audioChunks = [];
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) audioChunks.push(event.data); };
  mediaRecorder.onstop = () => void finishRecording(preferred);
  mediaRecorder.start();
  micButton.classList.add("recording");
  micLabel.textContent = t("micRecording", "Done");
  hint.textContent = t("hintListening", "Listening… click again to capture this moment.");
  recordingTimer = setTimeout(() => stopRecording(), 15000);
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  pendingMoment = captureMoment();
  clearTimeout(recordingTimer);
  mediaRecorder.stop();
  recordingStream?.getTracks().forEach((track) => track.stop());
  micButton.classList.remove("recording");
  micLabel.textContent = t("micIdle", "Talk");
  hint.textContent = t("hintTranscribing", "Transcribing locally…");
}

async function finishRecording(contentType) {
  try {
    const audio = new Blob(audioChunks, { type: contentType });
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: audio,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || t("transcribeFailed", "Speech recognition failed"));
    messageInput.value = result.text;
    await postMessage(result.text, pendingMoment || captureMoment());
  } catch (error) {
    hint.textContent = error.message;
  } finally {
    pendingMoment = null;
    audioChunks = [];
  }
}

async function pollState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const state = await response.json();
    const bridge = state.bridge || {};
    bridgeStatus = bridge.status || "starting";
    stateWrap.className = `bridge-state ${bridgeStatus}`;
    const labels = {
      ready: t("stateReady", "{buddyName} is seated"),
      thinking: t("stateThinking", "{buddyName} is looking at this frame"),
      starting: t("stateStarting", "Connecting to {backend}"),
      error: t("stateError", "Bridge error"),
      stopped: t("stateStopped", "Service stopped"),
    };
    stateText.textContent = labels[bridgeStatus] || t("stateStarting", "Connecting to {backend}");
    if (bridgeStatus === "error" && bridge.error) hint.textContent = bridge.error;
    if (state.response?.id && state.response.id !== lastResponseId) {
      lastResponseId = state.response.id;
      const moment = pendingMoments.get(state.response.id);
      addTimelineMessage("buddy", state.response.text, moment?.timeSeconds ?? movie.currentTime);
      pendingMoments.delete(state.response.id);
      showBuddyOverlay(state.response.text);
      hint.textContent = t("hintReply", "Keep watching, I'm right here.");
    }
  } catch {
    stateWrap.className = "bridge-state error";
    stateText.textContent = t("stateDisconnected", "Local service disconnected");
  }
}

function loadMovie(file) {
  if (!file) return;
  if (movieUrl) URL.revokeObjectURL(movieUrl);
  // The file never leaves the browser: it is played straight from an object URL.
  movieUrl = URL.createObjectURL(file);
  movie.src = movieUrl;
  movieName = file.name.replace(/\.[^.]+$/, "");
  pageTitle.textContent = movieName;
  document.querySelector("#movieName").textContent = file.name;
  emptyState.classList.add("hidden");
}

function loadSubtitles(text, name) {
  cues = parseSubtitles(text);
  const summary = t("subtitlesLoaded", "{count} lines").replaceAll("{count}", String(cues.length));
  document.querySelector("#subtitleName").textContent = `${name} · ${summary}`;
  metaSubtitle.textContent = summary;
  updateSubtitle();
}

movieInput.addEventListener("change", () => loadMovie(movieInput.files[0]));
document.querySelector("#chooseMovie").addEventListener("click", () => movieInput.click());
subtitleInput.addEventListener("change", async () => {
  const file = subtitleInput.files[0];
  if (!file) return;
  loadSubtitles(await file.text(), file.name);
});
hardSubtitleButton.addEventListener("click", () => {
  hardSubtitleMode = !hardSubtitleMode;
  hardSubtitleButton.classList.toggle("active", hardSubtitleMode);
  hardSubtitleButton.textContent = hardSubtitleMode
    ? t("hardSubtitleOn", "✓ Imported subtitles are AI-only")
    : t("hardSubtitleOff", "Subtitles are in the picture");
  const summary = t("subtitlesLoaded", "{count} lines").replaceAll("{count}", String(cues.length));
  metaSubtitle.textContent = hardSubtitleMode
    ? t("hardSubtitleMeta", "Burned-in subtitles")
    : (cues.length ? summary : t("subtitlesNone", "No subtitles loaded"));
  document.querySelector("#subtitleName").textContent = hardSubtitleMode
    ? (cues.length ? t("aiTimeline", "AI timeline · {count} lines").replaceAll("{count}", String(cues.length)) : t("fromFrame", "read from the current frame"))
    : (cues.length ? summary : t("labelNone", "none"));
  updateSubtitle();
});
movie.addEventListener("timeupdate", updateSubtitle);
movie.addEventListener("timeupdate", maybeSendProactive);
movie.addEventListener("seeked", updateSubtitle);
movie.addEventListener("play", () => {
  if (!Number.isFinite(nextProactiveAt)) scheduleNextProactive(35);
});
proactiveEnabled.addEventListener("change", () => {
  if (proactiveEnabled.checked) {
    scheduleNextProactive(35);
    hint.textContent = t("proactiveOn", "Proactive mode is on; I'll speak up when a moment is worth it.");
  } else {
    nextProactiveAt = Infinity;
    hint.textContent = t("proactiveOff", "Proactive mode is off.");
  }
});
proactiveRate.addEventListener("change", () => {
  if (proactiveEnabled.checked) scheduleNextProactive();
});
document.querySelector("#send").addEventListener("click", () => postMessage(messageInput.value).catch((error) => { hint.textContent = error.message; }));
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    document.querySelector("#send").click();
  }
});
micButton.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") stopRecording();
  else startRecording().catch((error) => { hint.textContent = t("micFailed", "Microphone failed: ") + error.message; });
});
document.querySelector("#fullscreen").addEventListener("click", () => document.querySelector("#dropZone").requestFullscreen());

const dropZone = document.querySelector("#dropZone");
for (const type of ["dragenter", "dragover"]) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); });
for (const type of ["dragleave", "drop"]) dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); });
dropZone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files];
  const video = files.find((file) => file.type.startsWith("video/") || /\.(mkv|mp4|mov|avi|webm)$/i.test(file.name));
  const subtitle = files.find((file) => /\.(srt|vtt)$/i.test(file.name));
  if (video) loadMovie(video);
  if (subtitle) subtitle.text().then((text) => loadSubtitles(text, subtitle.name));
});

document.querySelector("#seedMessage")?.addEventListener("click", (event) => {
  if (movie.src) movie.currentTime = Number(event.currentTarget.dataset.seconds) || 0;
});

applyConfig().then(() => {
  pollState();
  setInterval(pollState, 700);
});
