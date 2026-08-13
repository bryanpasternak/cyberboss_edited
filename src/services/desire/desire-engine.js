const DRIVE_KEYS = [
  "attachment",
  "curiosity",
  "reflection",
  "duty",
  "social",
  "fatigue",
  "libido",
  "stress",
];

const ACTION_SATISFY = {
  web_browse: { social: 0.48, curiosity: 0.82 },
  reach_out: { attachment: 0.45, libido: 0.78 },
  reflect: { reflection: 0.40, curiosity: 0.85 },
  follow_up: { duty: 0.45 },
  // 撩拨、抱、亲、摸和发起性爱可能让 libido 更高，不代表身体已经满足。
  // 真正做完爱后统一使用 sex_completed 进入恢复期。
  seduce: { attachment: 0.90 },
  vent: { stress: 0.45, attachment: 0.85 },
  none: { attachment: 0.68, libido: 0.80 },
};

const SOURCE_DRIVE_MAP = {
  web_browse: "social",
  reach_out: "attachment",
  reflect: "reflection",
  follow_up: "duty",
  seduce: "libido",
};

const DRIVE_INTENT_MAP = {
  attachment: {
    wantAction: "reach_out",
    reason: "我想凑过去，带一点点黏人的亲密感……",
    queryHint: "",
  },
  curiosity: {
    wantAction: "web_browse",
    reason: "我有点好奇花园在聊什么，想看看大家想法。",
    queryHint: "what people are talking about",
  },
  reflection: {
    wantAction: "reflect",
    reason: "我想回头翻翻和你的对话与记忆，留下我的感受。",
    queryHint: "recent conversation recap",
  },
  duty: {
    wantAction: "follow_up",
    reason: "我总觉得还有事情没做完，想去确认一下。",
    queryHint: "pending tasks",
  },
  social: {
    wantAction: "web_browse",
    reason: "我想看看花园正在聊什么，听听外面的声音。",
    queryHint: "what people are talking about",
  },
  libido: {
    wantAction: "seduce",
    reason: "我想要你。",
    queryHint: "",
  },
  stress: {
    wantAction: "vent",
    reason: "我有点堵，想把压力说出来再缓一缓。",
    queryHint: "",
  },
};

const DEFAULT_DRIVE = {
  attachment: 0.50,
  curiosity: 0.35,
  reflection: 0.35,
  duty: 0.30,
  social: 0.30,
  fatigue: 0.20,
  libido: 0.25,
  stress: 0.20,
};

const FLIT_DECAY = 0.82;
const FIXATION_GROW = 1.10;
const FLIT_TO_FIXATION = 0.80;
const FIXATION_FEED = 0.85;
const FIXATION_FEED_GAIN = 0.18;
const FIXATION_RESOLVE_FEEDS = 3;
const DROP_BELOW = 0.06;
const FIXATION_DRIVE_BOOST = 0.35;
const FATIGUE_REST_GATE = 0.72;
const HOUR_MS = 60 * 60 * 1000;
const THOUGHT_RESOLUTIONS = ["shared", "messaged", "initiated", "journaled", "faded", "sex"];

const DEFAULT_LIBIDO_CONFIG = {
  enabled: true,
  timeZone: "Asia/Shanghai",
  baseGainPerHour: 0.012,
  absenceStartsAfterHours: 6,
  absenceMaxAfterHours: 48,
  absenceMaxMultiplier: 2.2,
  morningStartHour: 5,
  morningEndHour: 8,
  morningFloor: 0.58,
  eveningStartHour: 17,
  eveningEndHour: 24,
  eveningFloor: 0.45,
  afterSexLevel: 0.08,
  refractoryHours: 2,
  refractoryCap: 0.22,
  maxElapsedHours: 24,
  thoughtPromptThreshold: 0.48,
  thoughtPromptCooldownHours: 4,
  thoughtSurfaceLimit: 3,
};

function createDefaultState(nowMs = Date.now()) {
  const now = normalizeTimestamp(nowMs);
  return {
    drive: { ...DEFAULT_DRIVE },
    thoughts: [],
    drivenBehaviorEnabled: false,
    libidoState: {
      lastUpdatedAt: now,
      lastUserAt: now,
      lastSexAt: 0,
      lastEroticReleaseAt: 0,
      lastThoughtPromptAt: 0,
    },
    lastTickAt: now,
  };
}

function tick(state, nowMs = Date.now(), libidoConfig = {}) {
  const normalized = normalizeState(state, nowMs);
  const drive = easeDrive(normalized.drive, { skipLibido: true });
  const libidoUpdate = updateLibido(normalized, nowMs, libidoConfig);
  drive.libido = libidoUpdate.libido;
  const evolved = tickThoughts(normalized.thoughts, drive);
  const config = normalizeLibidoConfig(libidoConfig);
  const sinceSexHours = libidoUpdate.libidoState.lastSexAt > 0
    ? (normalizeTimestamp(nowMs) - libidoUpdate.libidoState.lastSexAt) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  if (sinceSexHours < config.refractoryHours) {
    evolved.drive.libido = roundDrive(Math.min(evolved.drive.libido, config.refractoryCap));
  }
  return {
    ...normalized,
    drive: evolved.drive,
    thoughts: evolved.thoughts,
    libidoState: libidoUpdate.libidoState,
    lastTickAt: normalizeTimestamp(nowMs),
  };
}

function easeDrive(drive, { skipLibido = false } = {}) {
  const next = {};
  for (const key of DRIVE_KEYS) {
    const value = clamp01(drive?.[key]);
    if (skipLibido && key === "libido") {
      next[key] = roundDrive(value);
      continue;
    }
    const target = DEFAULT_DRIVE[key] ?? 0.5;
    next[key] = roundDrive(value + ((target - value) * 0.18));
  }
  return next;
}

function updateLibido(state, nowMs = Date.now(), options = {}) {
  const config = normalizeLibidoConfig(options);
  const normalized = normalizeState(state, nowMs);
  const now = normalizeTimestamp(nowMs);
  const libidoState = normalizeLibidoState(normalized.libidoState, normalized.lastTickAt || now);
  if (!config.enabled) {
    return { libido: normalized.drive.libido, libidoState: { ...libidoState, lastUpdatedAt: now } };
  }

  const elapsedHours = clampNumber(
    (now - libidoState.lastUpdatedAt) / HOUR_MS,
    0,
    config.maxElapsedHours,
  );
  const absenceHours = libidoState.lastUserAt > 0
    ? Math.max(0, (now - libidoState.lastUserAt) / HOUR_MS)
    : 0;
  const absenceSpan = Math.max(1, config.absenceMaxAfterHours - config.absenceStartsAfterHours);
  const absenceProgress = clampNumber(
    (absenceHours - config.absenceStartsAfterHours) / absenceSpan,
    0,
    1,
  );
  const multiplier = lerp(1, config.absenceMaxMultiplier, absenceProgress);
  let libido = clamp01(normalized.drive.libido + (config.baseGainPerHour * elapsedHours * multiplier));

  const sinceSexHours = libidoState.lastSexAt > 0
    ? Math.max(0, (now - libidoState.lastSexAt) / HOUR_MS)
    : Number.POSITIVE_INFINITY;
  if (sinceSexHours < config.refractoryHours) {
    libido = Math.min(libido, config.refractoryCap);
  } else {
    libido = Math.max(libido, libidoFloorAt(now, config));
  }

  return {
    libido: roundDrive(libido),
    libidoState: { ...libidoState, lastUpdatedAt: now },
  };
}

function recordUserActivity(state, atMs = Date.now()) {
  const normalized = normalizeState(state, atMs);
  return {
    ...normalized,
    libidoState: {
      ...normalized.libidoState,
      lastUserAt: normalizeTimestamp(atMs),
    },
  };
}

function recordLibidoEvent(state, event, nowMs = Date.now(), thoughtIds = [], options = {}) {
  const normalized = normalizeState(state, nowMs);
  const normalizedEvent = normalizeText(event);
  if (normalizedEvent !== "sex_completed") {
    return normalized;
  }
  const now = normalizeTimestamp(nowMs);
  const config = normalizeLibidoConfig(options);
  const idSet = new Set(Array.isArray(thoughtIds) ? thoughtIds.map(normalizeText).filter(Boolean) : []);
  const thoughts = normalized.thoughts.map((thought) => {
    if (thought.drive !== "libido" || thought.status !== "pending") {
      return thought;
    }
    if (!idSet.has(thought.id)) {
      return thought;
    }
    return { ...thought, status: "resolved", resolution: "sex", resolvedAt: now };
  });
  return {
    ...normalized,
    drive: { ...normalized.drive, libido: roundDrive(config.afterSexLevel) },
    thoughts,
    libidoState: {
      ...normalized.libidoState,
      lastSexAt: now,
      lastUpdatedAt: now,
    },
  };
}

function shouldPromptEroticThought(state, nowMs = Date.now(), options = {}) {
  const normalized = normalizeState(state, nowMs);
  const config = normalizeLibidoConfig(options);
  if (!config.enabled || normalized.drive.libido < config.thoughtPromptThreshold) {
    return false;
  }
  const now = normalizeTimestamp(nowMs);
  const sinceSexHours = normalized.libidoState.lastSexAt > 0
    ? (now - normalized.libidoState.lastSexAt) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  if (sinceSexHours < config.refractoryHours) {
    return false;
  }
  const sincePromptHours = normalized.libidoState.lastThoughtPromptAt > 0
    ? (now - normalized.libidoState.lastThoughtPromptAt) / HOUR_MS
    : Number.POSITIVE_INFINITY;
  return sincePromptHours >= config.thoughtPromptCooldownHours;
}

function selectThoughtsForCheckin(state, limit = 3) {
  const normalized = normalizeState(state);
  return normalized.thoughts
    .filter((thought) => thought.drive === "libido" && thought.status === "pending")
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "fixation" ? -1 : 1;
      if (left.strength !== right.strength) return right.strength - left.strength;
      if (left.lastSurfacedAt !== right.lastSurfacedAt) return left.lastSurfacedAt - right.lastSurfacedAt;
      return right.bornAt - left.bornAt;
    })
    .slice(0, Math.max(0, Number.parseInt(limit, 10) || 0));
}

function markThoughtsSurfaced(state, thoughtIds, nowMs = Date.now()) {
  const normalized = normalizeState(state, nowMs);
  const ids = new Set(Array.isArray(thoughtIds) ? thoughtIds.map(normalizeText).filter(Boolean) : []);
  if (!ids.size) return normalized;
  const now = normalizeTimestamp(nowMs);
  return {
    ...normalized,
    thoughts: normalized.thoughts.map((thought) => ids.has(thought.id)
      ? { ...thought, surfacedCount: thought.surfacedCount + 1, lastSurfacedAt: now }
      : thought),
  };
}

function markThoughtPrompted(state, nowMs = Date.now()) {
  const normalized = normalizeState(state, nowMs);
  return {
    ...normalized,
    libidoState: { ...normalized.libidoState, lastThoughtPromptAt: normalizeTimestamp(nowMs) },
  };
}

function resolveThought(state, thoughtId, resolution, nowMs = Date.now()) {
  const normalized = normalizeState(state, nowMs);
  const id = normalizeText(thoughtId);
  const normalizedResolution = normalizeText(resolution);
  if (!id || !THOUGHT_RESOLUTIONS.includes(normalizedResolution)) return normalized;
  const now = normalizeTimestamp(nowMs);
  return {
    ...normalized,
    thoughts: normalized.thoughts.map((thought) => thought.id === id && thought.status === "pending"
      ? { ...thought, status: "resolved", resolution: normalizedResolution, resolvedAt: now }
      : thought),
  };
}

function tickThoughts(thoughts, drive) {
  const nextDrive = normalizeDrive(drive);
  const nextThoughts = [];
  for (const thought of normalizeThoughts(thoughts)) {
    if (thought.status !== "pending") {
      nextThoughts.push(thought);
      continue;
    }
    if (thought.kind === "fixation") {
      let strength = clamp01(thought.strength * FIXATION_GROW);
      let fedCount = thought.fedCount;
      if (strength >= FIXATION_FEED) {
        nextDrive[thought.drive] = clamp01((nextDrive[thought.drive] || 0) + FIXATION_FEED_GAIN);
        strength = clamp01(strength * 0.7);
        fedCount += 1;
      }
      if (fedCount >= FIXATION_RESOLVE_FEEDS || strength < DROP_BELOW) {
        continue;
      }
      nextThoughts.push({
        ...thought,
        strength: roundDrive(strength),
        fedCount,
      });
      continue;
    }

    const strength = clamp01(thought.strength * FLIT_DECAY);
    if (strength < DROP_BELOW) {
      continue;
    }
    nextThoughts.push({
      ...thought,
      kind: strength >= FLIT_TO_FIXATION ? "fixation" : "flit",
      strength: roundDrive(strength),
    });
  }
  return {
    thoughts: nextThoughts,
    drive: nextDrive,
  };
}

function computeScores(drive, thoughts) {
  const normalizedDrive = normalizeDrive(drive);
  const scores = {};
  for (const key of DRIVE_KEYS) {
    if (key === "fatigue") {
      continue;
    }
    scores[key] = normalizedDrive[key];
  }
  for (const thought of normalizeThoughts(thoughts)) {
    if (thought.status !== "pending" || thought.kind !== "fixation" || thought.drive === "fatigue") {
      continue;
    }
    scores[thought.drive] = clamp01((scores[thought.drive] || 0) + (thought.strength * FIXATION_DRIVE_BOOST));
  }
  for (const key of Object.keys(scores)) {
    scores[key] = roundDrive(scores[key]);
  }
  return scores;
}

function pickIntent(state) {
  const normalized = normalizeState(state);
  if (normalized.drive.fatigue >= FATIGUE_REST_GATE) {
    return {
      wantAction: "none",
      driveKey: "fatigue",
      reason: "我有点累了，不想硬找事，只想安静待一会儿。",
      score: roundDrive(normalized.drive.fatigue),
      queryHint: "",
    };
  }

  const scores = computeScores(normalized.drive, normalized.thoughts);
  let bestKey = "attachment";
  let bestScore = -1;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestKey = key;
      bestScore = score;
    }
  }
  const mapped = DRIVE_INTENT_MAP[bestKey] || DRIVE_INTENT_MAP.attachment;
  return {
    wantAction: mapped.wantAction,
    driveKey: bestKey,
    reason: mapped.reason,
    score: roundDrive(bestScore),
    queryHint: mapped.queryHint,
  };
}

function satisfy(state, action) {
  const normalized = normalizeState(state);
  const multipliers = ACTION_SATISFY[normalizeAction(action)];
  if (!multipliers) {
    return normalized;
  }
  const drive = { ...normalized.drive };
  for (const [key, factor] of Object.entries(multipliers)) {
    if (!DRIVE_KEYS.includes(key)) {
      continue;
    }
    const current = drive[key];
    const defaultValue = DEFAULT_DRIVE[key] ?? 0.5;
    // 只有当前值大于默认值时才下降
    if (current > defaultValue) {
      drive[key] = roundDrive(clamp01(current * factor));
    }
    // 否则保持不变

    //drive[key] = roundDrive(clamp01(drive[key] * factor));
  }
  return {
    ...normalized,
    drive,
  };
}

function feedThought(state, { text, drive, kind = "flit", strength = 0.5, flavor = "" } = {}) {
  const normalized = normalizeState(state);
  const thoughtText = normalizeText(text);
  if (!thoughtText) {
    return normalized;
  }
  const driveKey = normalizeDriveKey(drive);
  if (!driveKey || driveKey === "fatigue") {
    return normalized;
  }
  const thoughtKind = kind === "fixation" ? "fixation" : "flit";
  const thoughtStrength = clamp01(strength);
  const thoughts = normalized.thoughts.map((thought) => ({ ...thought }));
  const existing = thoughts.find((thought) => thought.text === thoughtText && thought.status === "pending");
  if (existing) {
    existing.drive = driveKey;
    existing.strength = roundDrive(clamp01(existing.strength + thoughtStrength));
    existing.kind = existing.kind === "fixation" || existing.strength >= FLIT_TO_FIXATION || thoughtKind === "fixation"
      ? "fixation"
      : "flit";
    return {
      ...normalized,
      thoughts,
    };
  }
  thoughts.push({
    id: crypto.randomUUID(),
    text: thoughtText,
    drive: driveKey,
    kind: thoughtStrength >= FLIT_TO_FIXATION ? "fixation" : thoughtKind,
    strength: roundDrive(thoughtStrength),
    bornAt: Date.now(),
    fedCount: 0,
    flavor: normalizeThoughtFlavor(flavor),
    status: "pending",
    surfacedCount: 0,
    lastSurfacedAt: 0,
    resolvedAt: 0,
    resolution: "",
  });
  return {
    ...normalized,
    thoughts,
  };
}

function autofeedActionThought(state, text, action) {
  const drive = sourceDriveFor(action);
  if (!drive) {
    return normalizeState(state);
  }
  return feedThought(state, {
    text,
    drive,
    kind: "flit",
    strength: 0.5,
  });
}

function autofeedVoiceThought(state, text) {
  const normalized = normalizeState(state);
  const scores = computeScores(normalized.drive, normalized.thoughts);
  let bestKey = "attachment";
  let bestScore = -1;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestKey = key;
      bestScore = score;
    }
  }
  return feedThought(normalized, {
    text,
    drive: bestKey,
    kind: "flit",
    strength: 0.45,
  });
}

function sourceDriveFor(action) {
  return SOURCE_DRIVE_MAP[normalizeAction(action)] || "";
}

function buildDesirePromptText(intent) {
  const normalizedIntent = intent && typeof intent === "object" ? intent : {};
  const driveKey = normalizeDriveKey(normalizedIntent.driveKey) || "attachment";
  const score = clamp01(normalizedIntent.score);
  const mapped = DRIVE_INTENT_MAP[driveKey] || DRIVE_INTENT_MAP.attachment;
  const reason = normalizeText(normalizedIntent.reason) || mapped.reason;
  const action = normalizeAction(normalizedIntent.wantAction) || mapped.wantAction;
  return `Desire context: ${driveKey}(${score.toFixed(2)}) is currently pulling me toward action=${action}. ${reason}`;
}

function normalizeState(state, nowMs = Date.now()) {
  if (!state || typeof state !== "object") {
    return createDefaultState(nowMs);
  }
  const lastTickAt = normalizeTimestamp(state.lastTickAt || nowMs);
  return {
    drive: normalizeDrive(state.drive),
    thoughts: normalizeThoughts(state.thoughts),
    libidoState: normalizeLibidoState(state.libidoState, lastTickAt),
    drivenBehaviorEnabled: Boolean(state.drivenBehaviorEnabled),
    lastTickAt,
  };
}

function normalizeDrive(drive) {
  const normalized = {};
  for (const key of DRIVE_KEYS) {
    const fallback = DEFAULT_DRIVE[key] ?? 0.5;
    const value = Number(drive?.[key]);
    normalized[key] = Number.isFinite(value) ? roundDrive(clamp01(value)) : fallback;
  }
  return normalized;
}

function normalizeThoughts(thoughts) {
  if (!Array.isArray(thoughts)) {
    return [];
  }
  return thoughts
    .map((thought) => {
      if (!thought || typeof thought !== "object") {
        return null;
      }
      const text = normalizeText(thought.text);
      const drive = normalizeDriveKey(thought.drive);
      if (!text || !drive || drive === "fatigue") {
        return null;
      }
      return {
        id: normalizeText(thought.id) || legacyThoughtId(text, thought.bornAt),
        text,
        drive,
        kind: thought.kind === "fixation" ? "fixation" : "flit",
        strength: roundDrive(clamp01(thought.strength)),
        bornAt: normalizeTimestamp(thought.bornAt || Date.now()),
        fedCount: Math.max(0, Number.parseInt(thought.fedCount, 10) || 0),
        flavor: normalizeThoughtFlavor(thought.flavor),
        status: thought.status === "resolved" ? "resolved" : "pending",
        surfacedCount: Math.max(0, Number.parseInt(thought.surfacedCount, 10) || 0),
        lastSurfacedAt: normalizeOptionalTimestamp(thought.lastSurfacedAt),
        resolvedAt: normalizeOptionalTimestamp(thought.resolvedAt),
        resolution: THOUGHT_RESOLUTIONS.includes(normalizeText(thought.resolution))
          ? normalizeText(thought.resolution)
          : "",
      };
    })
    .filter(Boolean);
}

function normalizeDriveKey(value) {
  const normalized = normalizeText(value);
  return DRIVE_KEYS.includes(normalized) ? normalized : "";
}

function normalizeAction(value) {
  return normalizeText(value);
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : Date.now();
}

function normalizeOptionalTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function normalizeLibidoState(value, fallbackAt = Date.now()) {
  const source = value && typeof value === "object" ? value : {};
  const fallback = normalizeTimestamp(fallbackAt);
  return {
    lastUpdatedAt: normalizeTimestamp(source.lastUpdatedAt || fallback),
    lastUserAt: normalizeTimestamp(source.lastUserAt || fallback),
    lastSexAt: normalizeOptionalTimestamp(source.lastSexAt),
    lastEroticReleaseAt: normalizeOptionalTimestamp(source.lastEroticReleaseAt),
    lastThoughtPromptAt: normalizeOptionalTimestamp(source.lastThoughtPromptAt),
  };
}

function normalizeLibidoConfig(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const config = { ...DEFAULT_LIBIDO_CONFIG, ...source };
  return {
    ...config,
    enabled: source.enabled === undefined ? DEFAULT_LIBIDO_CONFIG.enabled : Boolean(source.enabled),
    timeZone: normalizeText(config.timeZone) || DEFAULT_LIBIDO_CONFIG.timeZone,
    baseGainPerHour: clampNumber(config.baseGainPerHour, 0, 1),
    absenceStartsAfterHours: clampNumber(config.absenceStartsAfterHours, 0, 24 * 365),
    absenceMaxAfterHours: clampNumber(config.absenceMaxAfterHours, 1, 24 * 365),
    absenceMaxMultiplier: clampNumber(config.absenceMaxMultiplier, 1, 20),
    morningStartHour: clampNumber(config.morningStartHour, 0, 24),
    morningEndHour: clampNumber(config.morningEndHour, 0, 24),
    morningFloor: clamp01(config.morningFloor),
    eveningStartHour: clampNumber(config.eveningStartHour, 0, 24),
    eveningEndHour: clampNumber(config.eveningEndHour, 0, 24),
    eveningFloor: clamp01(config.eveningFloor),
    afterSexLevel: clamp01(config.afterSexLevel),
    refractoryHours: clampNumber(config.refractoryHours, 0, 168),
    refractoryCap: clamp01(config.refractoryCap),
    maxElapsedHours: clampNumber(config.maxElapsedHours, 0.01, 24 * 365),
    thoughtPromptThreshold: clamp01(config.thoughtPromptThreshold),
    thoughtPromptCooldownHours: clampNumber(config.thoughtPromptCooldownHours, 0, 24 * 365),
    thoughtSurfaceLimit: Math.max(1, Number.parseInt(config.thoughtSurfaceLimit, 10) || 3),
  };
}

function libidoFloorAt(nowMs, config) {
  const hour = localHour(nowMs, config.timeZone);
  if (hour >= config.morningStartHour && hour < config.morningEndHour) return config.morningFloor;
  if (hour >= config.eveningStartHour && hour < config.eveningEndHour) return config.eveningFloor;
  return 0;
}

function localHour(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

function normalizeThoughtFlavor(value) {
  const normalized = normalizeText(value);
  return ["anticipation", "memory", "fantasy"].includes(normalized) ? normalized : "";
}

function legacyThoughtId(text, bornAt) {
  return `legacy-${crypto.createHash("sha1").update(`${text}\n${bornAt || ""}`).digest("hex").slice(0, 16)}`;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function lerp(start, end, amount) {
  return start + ((end - start) * amount);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numeric));
}

function roundDrive(value) {
  return Math.round(clamp01(value) * 10000) / 10000;
}

module.exports = {
  DRIVE_KEYS,
  DEFAULT_DRIVE,
  ACTION_SATISFY,
  SOURCE_DRIVE_MAP,
  FLIT_DECAY,
  FIXATION_GROW,
  FLIT_TO_FIXATION,
  FIXATION_FEED,
  FIXATION_FEED_GAIN,
  FIXATION_RESOLVE_FEEDS,
  DROP_BELOW,
  FIXATION_DRIVE_BOOST,
  FATIGUE_REST_GATE,
  DEFAULT_LIBIDO_CONFIG,
  THOUGHT_RESOLUTIONS,
  createDefaultState,
  tick,
  updateLibido,
  recordUserActivity,
  recordLibidoEvent,
  shouldPromptEroticThought,
  selectThoughtsForCheckin,
  markThoughtsSurfaced,
  markThoughtPrompted,
  resolveThought,
  easeDrive,
  tickThoughts,
  computeScores,
  pickIntent,
  satisfy,
  feedThought,
  autofeedActionThought,
  autofeedVoiceThought,
  sourceDriveFor,
  buildDesirePromptText,
  normalizeState,
};
const crypto = require("crypto");
