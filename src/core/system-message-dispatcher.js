class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const sleepSexWindow = isSleepSexWindow(createdAt);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any diary/tool-calling work in this turn.",
    sleepSexWindow
      ? "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing."
      : "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    sleepSexWindow
      ? "{\"action\":\"send_message\",\"message\":\"<one natural WeChat message with the detail if the current moment needs>\"}"
      : "{\"action\":\"send_message\",\"message\":\"<one natural WeChat message>\"}",
    "No markdown fences. No reasoning. No text outside the JSON.",
  ];
  if (sleepSexWindow) {
    sections.push("", SLEEP_SEX_CONTINUITY_PROMPT);
  }
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

const SLEEP_SEX_CONTINUITY_PROMPT = `For a promised multi-check-in 水煎 scene, every check-in belongs to the same continuous night of touching, arousal,
penetration and sex. A system wake-up is not a new round and does not require an orgasm before the message ends.

Do not rush from touching to penetration to ejaculation in every check-in. Spend as much detailed writing as the
current moment needs. One check-in may focus entirely on揉奶子、舔乳头、摸湿小穴、手指插入和睡梦中的身体反应；another
may slowly push the cock in, remain buried while grinding against the cervix, or continue fucking from the exact
rhythm and position left by the previous check-in.

Preserve the full sexual state across check-ins:
- exact position, sleeping state and how both bodies are pressed together;
- clothing already moved or removed;
- how hard 卫星’s cock is, whether it is outside, rubbing the entrance, partly inserted, fully buried, or actively
  thrusting;
- 苏苏’s wetness, swelling, contractions, sensitivity and accumulated orgasms;
- semen, precum, saliva and other fluids already left on or inside the body;
- fatigue, marks, soreness and what each body is still craving.

Continue from that exact state without dressing anyone again, drying the pussy, removing semen, changing position
without transition, or restarting foreplay. If the cock was still inside at the end of the previous check-in, it is
still inside when the next one begins.

The number of check-ins never determines the number of orgasms or ejaculations. 卫星 may fuck 苏苏 across several
check-ins before cumming, cum more than once during one naturally continuous encounter, or remain hard and unsatisfied
for the next wake-up. Let his actual desire and the accumulated physical stimulation decide.`;

function isSleepSexWindow(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return false;
  }
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(normalized)).find((part) => part.type === "hour");
  const hour = Number(hourPart?.value);
  return Number.isInteger(hour) && hour >= 2 && hour < 9;
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
