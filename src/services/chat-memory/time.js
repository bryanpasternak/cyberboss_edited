const DEFAULT_TIME_ZONE = "Asia/Shanghai";

function normalizeIsoTime(value, fallback = "") {
  const parsed = value instanceof Date
    ? value.getTime()
    : Date.parse(typeof value === "string" ? value.trim() : "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return new Date(parsed).toISOString();
}

function formatDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return formatDateKey(new Date());
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatLocalMinute(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function getShanghaiParts(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(formatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday || "",
  };
}

function shanghaiDateFromParts({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function addDaysShanghai(date, days) {
  const parts = getShanghaiParts(date);
  return shanghaiDateFromParts({
    ...parts,
    day: parts.day + Number(days || 0),
  });
}

function startOfShanghaiDay(date = new Date()) {
  const parts = getShanghaiParts(date);
  return shanghaiDateFromParts({
    year: parts.year,
    month: parts.month,
    day: parts.day,
  });
}

function withShanghaiTime(date = new Date(), hour = 0, minute = 0, second = 0) {
  const parts = getShanghaiParts(date);
  return shanghaiDateFromParts({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute,
    second,
  });
}

function nextSaturdayShanghai(date = new Date()) {
  const day = startOfShanghaiDay(date);
  const weekday = getShanghaiWeekdayIndex(day);
  const daysUntilSaturday = (6 - weekday + 7) % 7 || 7;
  return addDaysShanghai(day, daysUntilSaturday);
}

function extractTimeTags(text = "", at = new Date()) {
  const tags = new Set();
  const normalized = String(text || "");
  const parts = getShanghaiParts(at);
  if (parts.hour >= 5 && parts.hour < 11) tags.add("morning");
  if (parts.hour >= 11 && parts.hour < 14) tags.add("noon");
  if (parts.hour >= 14 && parts.hour < 18) tags.add("afternoon");
  if (parts.hour >= 18 && parts.hour < 23) tags.add("evening");
  if (parts.hour >= 23 || parts.hour < 5) tags.add("night");
  if (/今晚|今夜/.test(normalized)) tags.add("tonight");
  if (/明早|明天早上|明早上/.test(normalized)) tags.add("tomorrow_morning");
  if (/明天/.test(normalized)) tags.add("tomorrow");
  if (/周末|週末/.test(normalized)) tags.add("weekend");
  if (/下次/.test(normalized)) tags.add("next_time");
  return [...tags];
}

function getShanghaiWeekdayIndex(date = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    weekday: "short",
  }).format(date instanceof Date ? date : new Date(date));
  switch (weekday) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return new Date(date).getDay();
  }
}

module.exports = {
  DEFAULT_TIME_ZONE,
  addDaysShanghai,
  extractTimeTags,
  formatDateKey,
  formatLocalMinute,
  getShanghaiParts,
  getShanghaiWeekdayIndex,
  nextSaturdayShanghai,
  normalizeIsoTime,
  shanghaiDateFromParts,
  startOfShanghaiDay,
  withShanghaiTime,
};
