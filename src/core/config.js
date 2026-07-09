const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = process.env.CYBERBOSS_STATE_DIR || path.join(os.homedir(), ".cyberboss");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot: readTextEnv("CYBERBOSS_WORKSPACE_ROOT") || process.cwd(),
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    channels: resolveEnabledChannels(),
    defaultOutboundChannel: readTextEnv("CYBERBOSS_DEFAULT_OUTBOUND_CHANNEL") || "weixin",
    identityMapFile: path.join(stateDir, "identity-map.json"),
    lastActiveChannelFile: path.join(stateDir, "last-active-channel.json"),
    telegramApiBaseUrl: readTextEnv("CYBERBOSS_TELEGRAM_API_BASE_URL") || "https://api.telegram.org",
    telegramBotToken: readTextEnv("CYBERBOSS_TELEGRAM_BOT_TOKEN"),
    telegramAllowedChatIds: readListEnv("CYBERBOSS_TELEGRAM_ALLOWED_CHAT_IDS"),
    telegramShowThinking: readOptionalBoolEnv("CYBERBOSS_TELEGRAM_SHOW_THINKING") !== false,
    telegramMinChunkChars: readIntEnv("CYBERBOSS_TELEGRAM_MIN_CHUNK_CHARS"),
    telegramConfigFile: path.join(stateDir, "telegram-config.json"),
    telegramOffsetFile: path.join(stateDir, "telegram-offset.json"),
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "codex",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    chatMemoryDir: path.join(stateDir, "chat-memory"),
    chatMemoryRawDir: path.join(stateDir, "chat-memory", "raw"),
    chatMemoryChunksFile: path.join(stateDir, "chat-memory", "chunks.jsonl"),
    chatMemoryStateFile: path.join(stateDir, "chat-memory", "chunk-state.json"),
    chatMemoryEmbeddingCacheFile: path.join(stateDir, "chat-memory", "embeddings-cache.jsonl"),
    chatMemoryConfigFile: path.join(stateDir, "chat-memory", "config.json"),
    chatMemoryProcessingLockFile: path.join(stateDir, "chat-memory", "processing-lock.json"),
    chatMemoryMemoriesFile: path.join(stateDir, "chat-memory", "memories.jsonl"),
    chatMemorySummaryStateFile: path.join(stateDir, "chat-memory", "summary-state.json"),
    promiseStoreFile: path.join(stateDir, "promises", "promises.json"),
    promiseArchiveFile: path.join(stateDir, "promises", "archive.jsonl"),
    chatMemoryEnabled: readBoolEnv("CYBERBOSS_CHAT_MEMORY_ENABLED"),
    chatMemoryCaptureEnabled: readOptionalBoolEnv("CYBERBOSS_CHAT_MEMORY_CAPTURE_ENABLED") !== false,
    chatMemoryIdleMs: readIntEnv("CYBERBOSS_CHAT_MEMORY_IDLE_MS") || 1_800_000,
    chatMemoryChunkMaxChars: readIntEnv("CYBERBOSS_CHAT_MEMORY_CHUNK_MAX_CHARS") || 1200,
    chatMemoryInjectEnabled: readOptionalBoolEnv("CYBERBOSS_CHAT_MEMORY_INJECT_ENABLED") !== false,
    chatMemoryInjectLimit: readIntEnv("CYBERBOSS_CHAT_MEMORY_INJECT_LIMIT") || 6,
    chatMemoryToolEnabled: readOptionalBoolEnv("CYBERBOSS_CHAT_MEMORY_TOOL_ENABLED") !== false,
    chatMemoryEmbedProvider: readTextEnv("CYBERBOSS_CHAT_MEMORY_EMBED_PROVIDER") || "local-hashed-ngram-512",
    chatMemoryEmbedBaseUrl: readTextEnv("CYBERBOSS_CHAT_MEMORY_EMBED_BASE_URL"),
    chatMemoryEmbedModel: readTextEnv("CYBERBOSS_CHAT_MEMORY_EMBED_MODEL") || "local-hashed-ngram-512",
    chatMemoryEmbedApiKey: readTextEnv("CYBERBOSS_CHAT_MEMORY_EMBED_API_KEY") || readTextEnv("DASHSCOPE_API_KEY") || readTextEnv("OPENAI_API_KEY"),
    chatMemoryDeepSeekEnabled: readBoolEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_ENABLED"),
    chatMemoryDeepSeekBaseUrl: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_BASE_URL") || "https://api.deepseek.com/v1",
    chatMemoryDeepSeekApiKey: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_API_KEY"),
    chatMemoryDeepSeekModel: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_MODEL") || "deepseek-chat",
    chatMemoryDeepSeekTimeoutMs: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_TIMEOUT_MS") || 30000,
    chatMemoryDeepSeekProxy: readTextEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_PROXY"),
    chatMemoryDeepSeekVerbose: readBoolEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_VERBOSE"),
    chatMemoryCronHours: parseCronHours(readTextEnv("CYBERBOSS_CHAT_MEMORY_CRON_HOURS") || "3,15"),
    chatMemorySummaryMaxTurnsPerBatch: readIntEnv("CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_TURNS_PER_BATCH") || 30,
    chatMemorySummaryMaxCharsPerBatch: readIntEnv("CYBERBOSS_CHAT_MEMORY_SUMMARY_MAX_CHARS_PER_BATCH") || 6000,
    chatMemoryDeepSeekRerankEnabled: readOptionalBoolEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_ENABLED") !== false,
    chatMemoryDeepSeekRerankPoolSize: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_POOL_SIZE") || 20,
    chatMemoryDeepSeekRerankContextTurns: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_CONTEXT_TURNS") || 5,
    chatMemoryDeepSeekRerankTimeoutMs: readIntEnv("CYBERBOSS_CHAT_MEMORY_DEEPSEEK_RERANK_TIMEOUT_MS") || 5000,
    promiseMemoryEnabled: readOptionalBoolEnv("CYBERBOSS_PROMISE_MEMORY_ENABLED") !== false,
    promisePassiveInjectEnabled: readOptionalBoolEnv("CYBERBOSS_PROMISE_PASSIVE_INJECT_ENABLED") !== false,
    promiseActiveTriggerEnabled: readBoolEnv("CYBERBOSS_PROMISE_ACTIVE_TRIGGER_ENABLED"),
    promiseClassifierEnabled: readBoolEnv("CYBERBOSS_PROMISE_CLASSIFIER_ENABLED"),
    promiseClassifierProvider: readTextEnv("CYBERBOSS_PROMISE_CLASSIFIER_PROVIDER") || "openai-compatible",
    promiseClassifierBaseUrl: readTextEnv("CYBERBOSS_PROMISE_CLASSIFIER_BASE_URL"),
    promiseClassifierApiKey: readTextEnv("CYBERBOSS_PROMISE_CLASSIFIER_API_KEY")
      || readTextEnv("DASHSCOPE_API_KEY")
      || readTextEnv("GEMINI_API_KEY")
      || readTextEnv("OPENAI_API_KEY"),
    promiseClassifierModel: readTextEnv("CYBERBOSS_PROMISE_CLASSIFIER_MODEL"),
    promiseClassifierTimeoutMs: readIntEnv("CYBERBOSS_PROMISE_CLASSIFIER_TIMEOUT_MS") || 15000,
    promiseClassifierVerbose: readBoolEnv("CYBERBOSS_PROMISE_CLASSIFIER_VERBOSE"),
    promiseClassifierProxy: readTextEnv("CYBERBOSS_PROMISE_CLASSIFIER_PROXY"),
    promiseInjectCooldownMs: readIntEnv("CYBERBOSS_PROMISE_INJECT_COOLDOWN_MS") || 30 * 60_000,
    promiseNextTimeCooldownMs: readIntEnv("CYBERBOSS_PROMISE_NEXT_TIME_COOLDOWN_MS") || 6 * 60 * 60_000,
    promiseNextTimeWindowHours: readTextEnv("CYBERBOSS_PROMISE_NEXT_TIME_WINDOW_HOURS") || "15-17,20-24",
    promiseMaxInjectCount: readIntEnv("CYBERBOSS_PROMISE_MAX_INJECT_COUNT") || 3,
    promiseExpiredGraceMs: readIntEnv("CYBERBOSS_PROMISE_EXPIRED_GRACE_MS") || 12 * 60 * 60_000,
    desireStateFile: path.join(stateDir, "desire-state.json"),
    desireDriven: readBoolEnv("CYBERBOSS_DESIRE_DRIVEN"),
    desireThoughtMax: readIntEnv("CYBERBOSS_DESIRE_THOUGHT_MAX") || 80,
    desirePanelHost: readTextEnv("CYBERBOSS_DESIRE_PANEL_HOST") || "127.0.0.1",
    desirePanelPort: readIntEnv("CYBERBOSS_DESIRE_PANEL_PORT") || 8765,
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    startupPromptFile: resolveOptionalPath(readTextEnv("CYBERBOSS_STARTUP_PROMPT_FILE")) || path.join(process.cwd(), "anchor", "startup_prompt.txt"),
    midnightTriggerFile: resolveOptionalPath(readTextEnv("CYBERBOSS_MIDNIGHT_TRIGGER_FILE")) || path.join(process.cwd(), "anchor", "midnight_trigger.txt"),
    anchorDir: resolveOptionalPath(readTextEnv("CYBERBOSS_ANCHOR_DIR")) || path.join(process.cwd(), "anchor"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir: path.join(stateDir, "diary"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexModel: readTextEnv("CYBERBOSS_CODEX_MODEL"),
    codexModelProvider: readTextEnv("CYBERBOSS_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT"),
    visionMode: readTextEnv("CYBERBOSS_VISION_MODE") || "auto",
    visionProvider: readTextEnv("CYBERBOSS_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl: readTextEnv("CYBERBOSS_VISION_API_BASE_URL"),
    visionApiKey: readTextEnv("CYBERBOSS_VISION_API_KEY"),
    visionModel: readTextEnv("CYBERBOSS_VISION_MODEL"),
    visionTimeoutMs: readIntEnv("CYBERBOSS_VISION_TIMEOUT_MS") || 30_000,
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    autoCompactEnabled: readBoolEnv("CYBERBOSS_AUTO_COMPACT_ENABLED"),
    autoCompactThresholdTokens: readIntEnv("CYBERBOSS_AUTO_COMPACT_THRESHOLD_TOKENS") || 300_000,
    autoCompactCooldownMs: readIntEnv("CYBERBOSS_AUTO_COMPACT_COOLDOWN_MS") || 3_600_000,
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

function parseCronHours(value) {
  const raw = String(value || "");
  const hours = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((hour) => Number.isFinite(hour) && hour >= 0 && hour <= 23);
  return hours.length ? hours : [3, 15];
}

function resolveEnabledChannels() {
  const explicit = readListEnv("CYBERBOSS_CHANNELS").map((id) => id.toLowerCase()).filter(Boolean);
  if (explicit.length) {
    return Array.from(new Set(explicit));
  }
  const single = (readTextEnv("CYBERBOSS_CHANNEL") || "weixin").toLowerCase();
  return [single];
}

function resolveOptionalPath(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }
  return normalized;
}

module.exports = { readConfig };
