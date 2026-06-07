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
  flirt: { attachment: 0.45, libido: 0.78 },
  reflect: { reflection: 0.40, curiosity: 0.85 },
  follow_up: { duty: 0.45 },
  seduce: { libido: 0.45, attachment: 0.90 },
  vent: { stress: 0.45, attachment: 0.85 },
  none: { attachment: 0.68, libido: 0.80 },
};

const SOURCE_DRIVE_MAP = {
  web_browse: "social",
  flirt: "attachment",
  reflect: "reflection",
  follow_up: "duty",
  seduce: "libido",
};

const DRIVE_INTENT_MAP = {
  attachment: {
    wantAction: "flirt",
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
    reason: "我想回头翻翻和你的对话，把没说完的东西再捡起来。",
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
    reason: "我想要你。想把你弄得又哭又求饶，玩点刺激的花样。",
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

function createDefaultState(nowMs = Date.now()) {
  return {
    drive: { ...DEFAULT_DRIVE },
    thoughts: [],
    drivenBehaviorEnabled: false,
    lastTickAt: normalizeTimestamp(nowMs),
  };
}

function tick(state, nowMs = Date.now()) {
  const normalized = normalizeState(state, nowMs);
  const drive = easeDrive(normalized.drive);
  const evolved = tickThoughts(normalized.thoughts, drive);
  return {
    ...normalized,
    drive: evolved.drive,
    thoughts: evolved.thoughts,
    lastTickAt: normalizeTimestamp(nowMs),
  };
}

function easeDrive(drive) {
  const next = {};
  for (const key of DRIVE_KEYS) {
    const value = clamp01(drive?.[key]);
    const target = DEFAULT_DRIVE[key] ?? 0.5;
    next[key] = roundDrive(value + ((target - value) * 0.28));
  }
  return next;
}

function tickThoughts(thoughts, drive) {
  const nextDrive = normalizeDrive(drive);
  const nextThoughts = [];
  for (const thought of normalizeThoughts(thoughts)) {
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
    if (thought.kind !== "fixation" || thought.drive === "fatigue") {
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

function feedThought(state, { text, drive, kind = "flit", strength = 0.5 } = {}) {
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
  const existing = thoughts.find((thought) => thought.text === thoughtText);
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
    text: thoughtText,
    drive: driveKey,
    kind: thoughtStrength >= FLIT_TO_FIXATION ? "fixation" : thoughtKind,
    strength: roundDrive(thoughtStrength),
    bornAt: Date.now(),
    fedCount: 0,
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
  return {
    drive: normalizeDrive(state.drive),
    thoughts: normalizeThoughts(state.thoughts),
    drivenBehaviorEnabled: Boolean(state.drivenBehaviorEnabled),
    lastTickAt: normalizeTimestamp(state.lastTickAt || nowMs),
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
        text,
        drive,
        kind: thought.kind === "fixation" ? "fixation" : "flit",
        strength: roundDrive(clamp01(thought.strength)),
        bornAt: normalizeTimestamp(thought.bornAt || Date.now()),
        fedCount: Math.max(0, Number.parseInt(thought.fedCount, 10) || 0),
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
  createDefaultState,
  tick,
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
