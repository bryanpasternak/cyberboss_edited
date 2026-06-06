const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_TELEGRAM_CHUNK = 20;
const MAX_MIN_TELEGRAM_CHUNK = 4096;

function loadTelegramConfig(config) {
  const filePath = config?.telegramConfigFile;
  const envDefault = normalizeMinChunkChars(
    config?.telegramMinChunkChars,
    DEFAULT_MIN_TELEGRAM_CHUNK,
  );
  if (!filePath) {
    return { minChunkChars: envDefault };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      minChunkChars: normalizeMinChunkChars(parsed?.minChunkChars, envDefault),
    };
  } catch {
    return { minChunkChars: envDefault };
  }
}

function saveTelegramConfig(config, values) {
  const filePath = config?.telegramConfigFile;
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        minChunkChars: normalizeMinChunkChars(values?.minChunkChars),
      },
      null,
      2,
    ),
  );
}

function normalizeMinChunkChars(value, defaultValue = DEFAULT_MIN_TELEGRAM_CHUNK) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_MIN_TELEGRAM_CHUNK) {
    return parsed;
  }
  return defaultValue;
}

module.exports = {
  loadTelegramConfig,
  saveTelegramConfig,
  DEFAULT_MIN_TELEGRAM_CHUNK,
  MAX_MIN_TELEGRAM_CHUNK,
  normalizeMinChunkChars,
};
