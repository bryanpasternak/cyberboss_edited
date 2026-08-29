const path = require("path");
const { AnniversaryService } = require("./anniversary-service");
const { CalendarService } = require("./calendar-service");
const { FestivalProvider } = require("./festival-provider");
const { LocalHolidayProvider } = require("./holiday-provider");
const { JsonCollectionStore } = require("./json-store");
const { OverviewService } = require("./overview-service");
const { TodoService } = require("./todo-service");

function createLifeCalendarServices({
  projectRoot = path.resolve(__dirname, "../../.."),
  stateDir,
  timezone = "Asia/Shanghai",
  now = () => new Date(),
} = {}) {
  if (!stateDir) throw new Error("createLifeCalendarServices requires stateDir.");
  const holidayProvider = new LocalHolidayProvider({ rootDir: path.join(projectRoot, "data/calendar/holidays") });
  const festivalProvider = new FestivalProvider({ rulesFile: path.join(projectRoot, "data/calendar/festivals.zh-CN.json"), timezone });
  const calendar = new CalendarService({ holidayProvider, festivalProvider, timezone, now });
  const todos = new TodoService({
    store: new JsonCollectionStore({ filePath: path.join(stateDir, "life-calendar/todos.json") }),
    now,
    timezone,
  });
  const anniversaries = new AnniversaryService({
    store: new JsonCollectionStore({ filePath: path.join(stateDir, "life-calendar/anniversaries.json") }),
    now,
    today: () => calendar.getToday().date,
  });
  const overview = new OverviewService({ calendar, todos, anniversaries });
  return { calendar, todos, anniversaries, overview };
}

module.exports = { createLifeCalendarServices };
