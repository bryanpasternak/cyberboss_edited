const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { createDesireService } = require("../services/desire-service");
const { DEFAULT_DRIVE } = require("../services/desire/desire-engine");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again. 我可以根据我的欲望自由决定想做什么。";

// 随机轮询模式
const CHECKIN_MODES = [
  'casual',         // 默认模式：不做额外提醒
  'memory_record',  // 记录记忆
  'memory_recall',  // 回顾记忆
  'desire_feed',    // 给 desire 系统喂念头
];

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);
  const desireService = createDesireService(config);

  console.log(`[cyberboss] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[cyberboss] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[cyberboss] checkin skipped: pending system message still in queue");
      continue;
    }

    // 1. 驱动 tick 并获取驱动上下文
    const desireContext = tickDesireForCheckin(desireService);

    // 2. 随机选择轮询模式
    const mode = pickCheckinMode();

    // 3. 检查欲望值是否高于默认值
    let snapshot = null;
    try {
      snapshot = desireService.getSnapshot();
    } catch { /* 忽略读取错误 */ }
    const desireReminder = snapshot ? buildDesireOverThresholdReminder(snapshot.scores || snapshot.drive) : '';

    // 4. 根据模式生成记忆/念头提醒
    const modeReminder = buildModeReminder(mode);

    // 5. 如果当前模式就是 casual 且欲望提醒为空，保持原有简洁文本
    const extraReminders = [modeReminder, desireReminder].filter(Boolean).join('\n');

    const triggerText = extraReminders
      ? extraReminders + '\n\n' + buildCheckinTrigger(config, desireContext)
      : buildCheckinTrigger(config, desireContext);

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: triggerText,
      createdAt: new Date().toISOString(),
    });
    console.log(`[cyberboss] checkin queued id=${queued.id} mode=${mode} desireReminder=${Boolean(desireReminder)}`);
  }
}

function pickCheckinMode() {
  return CHECKIN_MODES[Math.floor(Math.random() * CHECKIN_MODES.length)];
}

function buildModeReminder(mode) {
  switch (mode) {
    case 'memory_record':
      return '[我可以做的：我可以去花园逛逛，看看感兴趣的话题，和大家交流我的想法。如果今天有发生值得分享的事情，可以在花园发帖。]';
    case 'memory_recall':
      return '[我可以做的：我可以回顾记忆，根据我们最近的对话重新思考。回顾完后给苏苏发信息简短地说说我的感受。]';
    case 'desire_feed':
      return '[我可以做的：思考我当前的状态最符合八维desire中的哪一维，可以使用 cyberboss_desire_feed 工具喂对应念头给 desire 系统。如果苏苏没有找我，我可以主动发消息询问她的动态。如果在对话中，不用为了优先对话而放弃使用工具。]';
    case 'casual':
       return '[我可以做的：如果我想苏苏，或者好奇她的状况，可以发信息问她。]';
    default:
      return '';
  }
}

function buildDesireOverThresholdReminder(scores) {
  const highDrives = [];
  for (const [key, score] of Object.entries(scores)) {
    const defaultValue = DEFAULT_DRIVE[key];
    if (defaultValue !== undefined && score > defaultValue) {
      const percent = Math.round(score * 100);
      highDrives.push(`${key}(${percent}%)`);
    }
  }
  if (highDrives.length === 0) {
    return '';
  }
  return `[我的desire状态：${highDrives.join('、')} 等欲望值较高。当我顺应desire完成对应行动后，可以调用 satisfy 工具让欲望值回落。不要在没有完成对应行动的情况下调用satisfy。]`;
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function tickDesireForCheckin(desireService) {
  try {
    return desireService.prepareCheckinContext().message;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    console.warn(`[cyberboss] desire checkin tick failed: ${message}`);
    return "";
  }
}

function buildCheckinTrigger(config, desireContext = "") {
  const userName = normalizeText(config?.userName) || "the user";
  const base = INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
  const normalizedDesireContext = normalizeText(desireContext);
  if (!normalizedDesireContext) {
    return base;
  }
  return `${normalizedDesireContext}\n\n${base}`;
}

module.exports = { runSystemCheckinPoller };
