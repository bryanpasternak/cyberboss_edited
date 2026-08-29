const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLifeCalendarServices } = require("../src/services/life-calendar");

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-life-calendar-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return createLifeCalendarServices({
    projectRoot: path.resolve(__dirname, ".."),
    stateDir,
    now: () => new Date("2026-08-29T04:00:00Z"),
  });
}

test("calendar distinguishes adjusted workdays and official holidays", (t) => {
  const { calendar } = fixture(t);
  const adjusted = calendar.getDay("2026-01-04");
  assert.equal(adjusted.weekdayName, "星期日");
  assert.equal(adjusted.isWorkday, true);
  assert.equal(adjusted.workStatus, "adjusted_workday");
  const holiday = calendar.getDay("2026-09-25");
  assert.equal(holiday.isOffDay, true);
  assert.equal(holiday.officialHoliday.name, "中秋节");
});

test("calendar recognizes solar and lunar festivals", (t) => {
  const { calendar } = fixture(t);
  assert.deepEqual(calendar.getDay("2026-02-14").festivals.map((item) => item.name), ["情人节"]);
  assert.deepEqual(calendar.getDay("2026-08-19").festivals.map((item) => item.name), ["七夕"]);
  assert.deepEqual(calendar.getDay("2026-09-25").festivals.map((item) => item.name), ["中秋节"]);
});

test("todos persist and only dated todos appear in a day overview", (t) => {
  const services = fixture(t);
  services.todos.create({ id: "dated", title: "完成日历框架", scheduledDate: "2026-08-29" });
  services.todos.create({ id: "inbox", title: "以后再安排" });
  const overview = services.overview.getDay("2026-08-29");
  assert.deepEqual(overview.todos.map((item) => item.id), ["dated"]);
  assert.equal(services.todos.complete("dated").status, "completed");
});

test("todo due instants are matched using the business timezone", (t) => {
  const services = fixture(t);
  services.todos.create({ id: "late", title: "深夜截止", dueAt: "2026-08-29T00:30:00+08:00" });
  assert.deepEqual(services.todos.list({ date: "2026-08-29" }).map((item) => item.id), ["late"]);
  assert.deepEqual(services.todos.list({ date: "2026-08-28" }), []);
});

test("anniversary counts inclusively and reports the next yearly occurrence", (t) => {
  const services = fixture(t);
  services.anniversaries.create({ id: "ours", name: "我们的纪念日", startDate: "2025-08-29" });
  const count = services.anniversaries.getCount("ours", { asOfDate: "2026-08-29" });
  assert.equal(count.daysSince, 366);
  assert.equal(count.nextOccurrence, "2026-08-29");
  assert.equal(count.daysUntilNext, 0);
  assert.equal(services.overview.getDay("2026-08-29").anniversaries.length, 1);
});
