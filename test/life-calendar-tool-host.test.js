const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createLifeCalendarServices } = require("../src/services/life-calendar");
const { ProjectToolHost } = require("../src/tools/tool-host");

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-life-calendar-mcp-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const lifeCalendar = createLifeCalendarServices({
    projectRoot: path.resolve(__dirname, ".."),
    stateDir,
    now: () => new Date("2026-08-29T04:00:00Z"),
  });
  const host = new ProjectToolHost({
    services: { lifeCalendar },
    runtimeContextStore: { resolveActiveContext: () => ({}) },
  });
  return { host, lifeCalendar };
}

test("project MCP host lists life calendar tools", (t) => {
  const { host } = fixture(t);
  const names = host.listTools().map((tool) => tool.name);
  assert.ok(names.includes("cyberboss_calendar_day"));
  assert.ok(names.includes("cyberboss_todo_create"));
  assert.ok(names.includes("cyberboss_anniversary_count"));
  assert.ok(names.includes("cyberboss_daily_overview"));
});

test("MCP tools create and read todos through shared services", async (t) => {
  const { host } = fixture(t);
  const created = await host.invokeTool("cyberboss_todo_create", {
    title: "完成 MCP 接线",
    scheduledDate: "2026-08-29",
    assignee: "shared",
  });
  const overview = await host.invokeTool("cyberboss_daily_overview", { date: "2026-08-29" });
  assert.equal(created.data.title, "完成 MCP 接线");
  assert.equal(overview.data.todos.length, 1);
});

test("MCP tools expose calendar and anniversary counts", async (t) => {
  const { host } = fixture(t);
  const day = await host.invokeTool("cyberboss_calendar_day", { date: "2026-08-19" });
  const created = await host.invokeTool("cyberboss_anniversary_create", {
    name: "我们的纪念日",
    startDate: "2025-08-29",
  });
  const count = await host.invokeTool("cyberboss_anniversary_count", {
    id: created.data.id,
    asOfDate: "2026-08-29",
  });
  assert.deepEqual(day.data.festivals.map((item) => item.name), ["七夕"]);
  assert.equal(count.data.daysSince, 366);
});
