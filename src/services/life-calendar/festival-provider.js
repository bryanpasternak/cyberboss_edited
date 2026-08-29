const fs = require("fs");
const { assertDateString, dateToUtcNoon, getDateParts } = require("./date-utils");

class FestivalProvider {
  constructor({ rulesFile, timezone = "Asia/Shanghai" }) {
    this.timezone = timezone;
    const raw = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
    this.rules = Array.isArray(raw.festivals) ? raw.festivals : [];
  }

  getForDate(date) {
    const normalized = assertDateString(date);
    const solar = getDateParts(normalized);
    let lunar = null;
    return this.rules.filter((rule) => {
      if (rule.calendar === "solar") return rule.month === solar.month && rule.day === solar.day;
      if (rule.calendar !== "lunar") return false;
      lunar ||= getLunarParts(normalized, this.timezone);
      return rule.month === lunar.month && rule.day === lunar.day && !lunar.isLeapMonth;
    }).map((rule) => ({ id: rule.id, name: rule.name, calendar: rule.calendar }));
  }
}

function getLunarParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
  }).formatToParts(dateToUtcNoon(date));
  const monthPart = parts.find((part) => part.type === "month")?.value || "";
  const dayPart = parts.find((part) => part.type === "day")?.value || "";
  return {
    month: Number.parseInt(monthPart, 10),
    day: Number.parseInt(dayPart, 10),
    isLeapMonth: /闰|閏/.test(monthPart),
  };
}

module.exports = { FestivalProvider, getLunarParts };
