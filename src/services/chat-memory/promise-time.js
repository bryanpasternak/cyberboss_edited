const {
  addDaysShanghai,
  nextSaturdayShanghai,
  normalizeIsoTime,
  startOfShanghaiDay,
  withShanghaiTime,
} = require("./time");

function parsePromiseDue(text = "", now = new Date()) {
  const normalized = String(text || "");
  const base = now instanceof Date ? now : new Date(now);
  if (/今晚|今夜/.test(normalized)) {
    const due = withShanghaiTime(base, 20, 0, 0);
    return buildDueWindow("tonight", due, 30, 2359);
  }
  // if (/晚上/.test(normalized) && !hourMinuteCandidate(normalized)) {
  //   const due = withShanghaiTime(base, 20, 0, 0);
  //   return buildDueWindow("evening", due, 1800, 2359);
  // }
  if (/明早|明早上/.test(normalized)) {
    const due = withShanghaiTime(addDaysShanghai(base, 1), 8, 0, 0);
    return buildDueWindow("tomorrow_morning", due, 630, 1030);
  }
  if (/周末|週末/.test(normalized)) {
    const due = withShanghaiTime(nextSaturdayShanghai(base), 20, 0, 0);
    return buildDueWindow("weekend", due, 1800, 2359);
  }
  const hourMinute = normalized.match(/(上午|下午|晚上|中午)?\s*(\d{1,2})点(?:(\d{1,2})分)?/);
  // if (hourMinute) {
  //   const day = /明天|明日/.test(normalized) ? addDaysShanghai(base, 1) : base;
  //   let hour = Number(hourMinute[2]);
  //   const period = hourMinute[1] || "";
  //   if (/下午|晚上/.test(period) && hour < 12) {
  //     hour += 12;
  //   }
  //   if (/上午/.test(period) && hour === 12) {
  //     hour = 0;
  //   }
  //   const minute = Number(hourMinute[3] || 0);
  //   const due = withShanghaiTime(day, hour, minute, 0);
  //   return buildExplicitDueWindow("explicit_time", due, 30);
  // }
  // if (/明天/.test(normalized)) {
  //   const due = withShanghaiTime(addDaysShanghai(base, 1), 12, 0, 0);
  //   return buildDueWindow("tomorrow", due, 930, 2230);
  // }
  // if (/下次/.test(normalized)) {
  //   return {
  //     dueType: "next_time",
  //     dueAt: "",
  //     dueWindowStartAt: "",
  //     dueWindowEndAt: "",
  //   };
  // }
  if (/回头|改天/.test(normalized)) {
    const due = addDaysShanghai(startOfShanghaiDay(base), 3);
    return buildDueWindow("later", due, 900, 2200);
  }
  return null;
}

function buildDueWindow(dueType, due, windowStartMinutes, windowEndMinutes) {
  const base = normalizeIsoTime(due, "");
  if (!base) {
    return null;
  }
  const start = new Date(base);
  const end = new Date(base);
  const startMinutes = typeof windowStartMinutes === "number" ? windowStartMinutes : 0;
  const endMinutes = typeof windowEndMinutes === "number" ? windowEndMinutes : 2359;
  const startHour = Math.floor(startMinutes / 100);
  const startMinute = startMinutes % 100;
  const endHour = Math.floor(endMinutes / 100);
  const endMinute = endMinutes % 100;
  const startWindow = withShanghaiTime(start, startHour, startMinute, 0);
  const endWindow = withShanghaiTime(end, endHour, endMinute, 0);
  return {
    dueType,
    dueAt: base,
    dueWindowStartAt: normalizeIsoTime(startWindow, base),
    dueWindowEndAt: normalizeIsoTime(endWindow, base),
  };
}

function buildExplicitDueWindow(dueType, due, windowMinutes) {
  const base = normalizeIsoTime(due, "");
  if (!base) {
    return null;
  }
  const dueMs = Date.parse(base);
  const deltaMs = Math.max(0, Number(windowMinutes) || 0) * 60_000;
  return {
    dueType,
    dueAt: base,
    dueWindowStartAt: new Date(dueMs - deltaMs).toISOString(),
    dueWindowEndAt: new Date(dueMs + deltaMs).toISOString(),
  };
}

function hourMinuteCandidate(text) {
  return /(上午|下午|晚上|中午)?\s*\d{1,2}点(?:(\d{1,2})分)?/.test(String(text || ""));
}

module.exports = { parsePromiseDue };
