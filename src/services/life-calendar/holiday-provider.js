const fs = require("fs");
const path = require("path");
const { assertDateString, getDateParts } = require("./date-utils");

class LocalHolidayProvider {
  constructor({ rootDir, region = "CN" }) {
    this.rootDir = rootDir;
    this.region = region;
    this.cache = new Map();
  }

  getDay(date) {
    const normalized = assertDateString(date);
    const { year } = getDateParts(normalized);
    const yearData = this.getYear(year);
    const day = yearData.daysByDate.get(normalized) || null;
    return {
      available: yearData.available,
      source: yearData.source,
      day,
    };
  }

  getYear(year) {
    const numericYear = Number(year);
    if (this.cache.has(numericYear)) return this.cache.get(numericYear);
    const filePath = path.join(this.rootDir, this.region, `${numericYear}.json`);
    if (!fs.existsSync(filePath)) {
      const missing = { available: false, source: null, days: [], daysByDate: new Map() };
      this.cache.set(numericYear, missing);
      return missing;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (Number(raw.year) !== numericYear || !Array.isArray(raw.days)) {
      throw new Error(`Invalid holiday data: ${filePath}`);
    }
    const days = raw.days.map((entry) => ({
      name: String(entry.name || "").trim(),
      date: assertDateString(entry.date, "holiday date"),
      isOffDay: Boolean(entry.isOffDay),
    }));
    const loaded = {
      available: true,
      source: { papers: Array.isArray(raw.papers) ? raw.papers.slice() : [], filePath },
      days,
      daysByDate: new Map(days.map((entry) => [entry.date, entry])),
    };
    this.cache.set(numericYear, loaded);
    return loaded;
  }
}

module.exports = { LocalHolidayProvider };
