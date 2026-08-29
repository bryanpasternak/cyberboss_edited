const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertDateString(value, fieldName = "date") {
  const normalized = String(value || "").trim();
  const match = normalized.match(DATE_PATTERN);
  if (!match) throw new Error(`${fieldName} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`${fieldName} is not a valid date.`);
  }
  return normalized;
}

function dateToUtcNoon(date) {
  const normalized = assertDateString(date);
  return new Date(`${normalized}T12:00:00Z`);
}

function instantDateInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("instant must be a valid datetime.");
  return todayInTimezone(timezone, parsed);
}

function addDays(date, amount) {
  const probe = dateToUtcNoon(date);
  probe.setUTCDate(probe.getUTCDate() + Number(amount || 0));
  return probe.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((dateToUtcNoon(to) - dateToUtcNoon(from)) / 86_400_000);
}

function getDateParts(date) {
  const normalized = assertDateString(date);
  return {
    date: normalized,
    year: Number(normalized.slice(0, 4)),
    month: Number(normalized.slice(5, 7)),
    day: Number(normalized.slice(8, 10)),
  };
}

function getWeekday(date) {
  const weekday = dateToUtcNoon(date).getUTCDay();
  return {
    weekday,
    weekdayName: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][weekday],
    isWeekend: weekday === 0 || weekday === 6,
  };
}

function todayInTimezone(timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeInstant(value, fieldName) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`${fieldName} must be a valid ISO 8601 datetime.`);
  return new Date(parsed).toISOString();
}

module.exports = {
  DEFAULT_TIMEZONE,
  addDays,
  assertDateString,
  dateToUtcNoon,
  daysBetween,
  getDateParts,
  getWeekday,
  instantDateInTimezone,
  normalizeInstant,
  todayInTimezone,
};
