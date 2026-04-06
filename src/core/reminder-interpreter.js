const { CodexRpcClient } = require("../adapters/runtime/codex/rpc-client");
const { extractThreadId, extractThreadIdFromParams, extractTurnIdFromParams } = require("../adapters/runtime/codex/message-utils");

const REMINDER_PARSE_TIMEOUT_MS = 45_000;

function createReminderInterpreter(config) {
  const client = new CodexRpcClient({
    endpoint: config.codexEndpoint,
    codexCommand: config.codexCommand,
    env: process.env,
  });

  return {
    async connect() {
      await client.connect();
      await client.initialize();
    },
    async close() {
      await client.close();
    },
    async interpret(userText) {
      const prompt = buildReminderInterpretationPrompt(userText);
      const response = await client.sendUserMessage({ text: prompt });
      const threadId = extractThreadId(response);
      if (!threadId) {
        throw new Error("reminder interpreter did not return threadId");
      }
      return waitForReminderInterpretationResult(client, threadId);
    },
  };
}

function looksLikeReminderIntent(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }
  return /提醒我|叫我|告诉我|记得|分钟后|小时后|天后|秒后|秒钟后|分钟|小时|明天|今晚|下午|早上/.test(normalized);
}

function buildReminderInterpretationPrompt(userText) {
  const now = new Date().toISOString();
  return [
    "You are a reminder parser.",
    "Current timezone: Asia/Shanghai.",
    `Current time: ${now}.`,
    "Interpret the user's message and decide whether it is a reminder request.",
    "Return JSON only with this exact shape:",
    "{\"schedule\":boolean,\"delay_seconds\":number|null,\"scheduled_at\":string|null,\"message\":string,\"reason\":string}",
    "Rules:",
    "- If the user is clearly asking for a reminder, set schedule=true.",
    "- Use delay_seconds for relative times like '30分钟后'.",
    "- Use scheduled_at in ISO 8601 with timezone offset for absolute times like '明天下午三点'.",
    "- message must be the short reminder content that should be sent later.",
    "- If it is not a reminder request or time is too ambiguous, set schedule=false and explain in reason.",
    "- Do not include markdown fences or extra prose.",
    "",
    `User message: ${JSON.stringify(String(userText || ""))}`,
  ].join("\n");
}

function waitForReminderInterpretationResult(client, threadId) {
  return new Promise((resolve, reject) => {
    let finalText = "";
    let activeTurnId = "";
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("reminder interpretation timed out"));
    }, REMINDER_PARSE_TIMEOUT_MS);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (message?.method === "item/completed" && params?.item?.type === "agentMessage") {
        finalText = String(params.item.text || "").trim();
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        try {
          resolve(parseReminderInterpretationResult(finalText));
        } catch (error) {
          reject(error);
        }
      }

      if (message?.method === "turn/failed") {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error("reminder interpretation turn failed"));
      }
    });
  });
}

function parseReminderInterpretationResult(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    throw new Error("empty reminder interpretation result");
  }

  const normalized = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const parsed = JSON.parse(normalized);
  return {
    schedule: !!parsed?.schedule,
    delaySeconds: Number.isFinite(Number(parsed?.delay_seconds)) ? Number(parsed.delay_seconds) : null,
    scheduledAt: typeof parsed?.scheduled_at === "string" ? parsed.scheduled_at.trim() : "",
    message: typeof parsed?.message === "string" ? parsed.message.trim() : "",
    reason: typeof parsed?.reason === "string" ? parsed.reason.trim() : "",
  };
}

function resolveReminderDueAtMs(parsed) {
  if (Number.isFinite(parsed?.delaySeconds) && parsed.delaySeconds > 0) {
    return Date.now() + parsed.delaySeconds * 1000;
  }
  if (parsed?.scheduledAt) {
    const dueAtMs = Date.parse(parsed.scheduledAt);
    if (Number.isFinite(dueAtMs)) {
      return dueAtMs;
    }
  }
  return 0;
}

function formatDelayText(delayMs) {
  const totalSeconds = Math.max(1, Math.round(Number(delayMs || 0) / 1000));
  if (totalSeconds % 86400 === 0) {
    return `${totalSeconds / 86400}d`;
  }
  if (totalSeconds % 3600 === 0) {
    return `${totalSeconds / 3600}h`;
  }
  if (totalSeconds % 60 === 0) {
    return `${totalSeconds / 60}m`;
  }
  return `${totalSeconds}s`;
}

module.exports = {
  createReminderInterpreter,
  formatDelayText,
  looksLikeReminderIntent,
  resolveReminderDueAtMs,
};
