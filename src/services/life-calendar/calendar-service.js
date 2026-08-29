const { addDays, assertDateString, getDateParts, getWeekday, todayInTimezone } = require("./date-utils");

class CalendarService {
  constructor({ holidayProvider, festivalProvider, timezone = "Asia/Shanghai", now = () => new Date() }) {
    this.holidayProvider = holidayProvider;
    this.festivalProvider = festivalProvider;
    this.timezone = timezone;
    this.now = now;
  }

  getToday() {
    return this.getDay(todayInTimezone(this.timezone, this.now()));
  }

  getDay(date) {
    const normalized = assertDateString(date);
    const weekday = getWeekday(normalized);
    const holidayResult = this.holidayProvider.getDay(normalized);
    const official = holidayResult.day;
    const isWorkday = official ? !official.isOffDay : !weekday.isWeekend;
    return {
      ...getDateParts(normalized),
      ...weekday,
      timezone: this.timezone,
      isWorkday,
      isOffDay: !isWorkday,
      workStatus: official ? (official.isOffDay ? "official_holiday" : "adjusted_workday") : (weekday.isWeekend ? "weekend" : "workday"),
      officialHoliday: official,
      holidayDataAvailable: holidayResult.available,
      festivals: this.festivalProvider.getForDate(normalized),
    };
  }

  getRange({ from, to }) {
    const start = assertDateString(from, "from");
    const end = assertDateString(to, "to");
    if (start > end) throw new Error("from must not be after to.");
    const days = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      days.push(this.getDay(date));
      if (days.length > 370) throw new Error("Calendar range cannot exceed 370 days.");
    }
    return { from: start, to: end, timezone: this.timezone, days };
  }

  getMonth({ year, month }) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) throw new Error("year and month are invalid.");
    const prefix = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return this.getRange({ from: `${prefix}-01`, to: `${prefix}-${String(lastDay).padStart(2, "0")}` });
  }
}

module.exports = { CalendarService };
