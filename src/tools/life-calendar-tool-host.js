class LifeCalendarToolHost {
  constructor({ services }) {
    this.services = services;
  }

  listTools() {
    return LIFE_CALENDAR_TOOLS.map(({ handler, ...tool }) => tool);
  }

  async invokeTool(toolName, args = {}) {
    const tool = LIFE_CALENDAR_TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Unknown life calendar tool: ${toolName}`);
    return await tool.handler(this.services, args || {});
  }
}

const LIFE_CALENDAR_TOOLS = [
  {
    name: "cyberboss_calendar_day",
    description: "Read one calendar day, including weekday, work/rest status, official holiday or adjusted workday, and festivals. Omit date to read today in Asia/Shanghai.",
    inputSchema: objectSchema({
      date: { type: "string", description: "Optional date in YYYY-MM-DD; defaults to today." },
    }),
    handler(services, args) {
      const data = args.date ? services.calendar.getDay(args.date) : services.calendar.getToday();
      return { text: formatCalendarDay(data), data };
    },
  },
  {
    name: "cyberboss_calendar_range",
    description: "Read calendar information for an inclusive date range of at most 370 days.",
    inputSchema: objectSchema({
      from: { type: "string", description: "First date in YYYY-MM-DD." },
      to: { type: "string", description: "Last date in YYYY-MM-DD." },
    }, ["from", "to"]),
    handler(services, args) {
      const data = services.calendar.getRange(args);
      return { text: `Calendar range ${data.from} to ${data.to}: ${data.days.length} days.`, data };
    },
  },
  {
    name: "cyberboss_todo_list",
    description: "List todos, optionally filtered by status, assignee, or a local calendar date. Todos without dates remain available when no date filter is used.",
    inputSchema: objectSchema({
      status: { type: "string", description: "Optional pending, completed, or cancelled status." },
      assignee: { type: "string", description: "Optional assignee such as susu, satellite, or shared." },
      date: { type: "string", description: "Optional local date in YYYY-MM-DD." },
    }),
    handler(services, args) {
      const data = services.todos.list(args);
      return { text: `Todos loaded: ${data.length}.`, data: { items: data, count: data.length } };
    },
  },
  {
    name: "cyberboss_todo_create",
    description: "Create a todo. A todo may have no date, a scheduled local date, a due instant, or both.",
    inputSchema: objectSchema({
      title: { type: "string", description: "Short todo title." },
      description: { type: "string", description: "Optional details." },
      assignee: { type: "string", description: "Optional susu, satellite, or shared; defaults to shared." },
      scheduledDate: { type: "string", description: "Optional planned date in YYYY-MM-DD." },
      dueAt: { type: "string", description: "Optional ISO 8601 deadline, preferably including timezone offset." },
    }, ["title"]),
    handler(services, args) {
      const data = services.todos.create(args);
      return { text: `Todo created: ${data.title}`, data };
    },
  },
  {
    name: "cyberboss_todo_update",
    description: "Update editable fields of an existing todo. Only supplied fields are changed.",
    inputSchema: objectSchema({
      id: { type: "string", description: "Todo id." },
      title: { type: "string" },
      description: { type: "string" },
      status: { type: "string", description: "pending, completed, or cancelled." },
      assignee: { type: "string" },
      scheduledDate: { type: ["string", "null"] },
      dueAt: { type: ["string", "null"] },
    }, ["id"]),
    handler(services, args) {
      const { id, ...patch } = args;
      const data = services.todos.update(id, patch);
      return { text: `Todo updated: ${data.title}`, data };
    },
  },
  {
    name: "cyberboss_todo_complete",
    description: "Mark one existing todo as completed.",
    inputSchema: objectSchema({ id: { type: "string", description: "Todo id." } }, ["id"]),
    handler(services, args) {
      const data = services.todos.complete(args.id);
      return { text: `Todo completed: ${data.title}`, data };
    },
  },
  {
    name: "cyberboss_anniversary_list",
    description: "List saved anniversaries. Set asOfDate to include current counts and next yearly occurrences.",
    inputSchema: objectSchema({
      asOfDate: { type: "string", description: "Optional date in YYYY-MM-DD for calculated counts." },
    }),
    handler(services, args) {
      const items = services.anniversaries.list();
      const data = args.asOfDate
        ? items.map((item) => services.anniversaries.getCount(item.id, { asOfDate: args.asOfDate }))
        : items;
      return { text: `Anniversaries loaded: ${data.length}.`, data: { items: data, count: data.length } };
    },
  },
  {
    name: "cyberboss_anniversary_create",
    description: "Create a Gregorian anniversary with yearly or non-repeating behavior.",
    inputSchema: objectSchema({
      name: { type: "string", description: "Anniversary name." },
      startDate: { type: "string", description: "Original date in YYYY-MM-DD." },
      countingRule: { type: "string", description: "inclusive (first day is day 1) or exclusive (first day is day 0)." },
      repeat: { type: "string", description: "yearly or none." },
    }, ["name", "startDate"]),
    handler(services, args) {
      const data = services.anniversaries.create(args);
      return { text: `Anniversary created: ${data.name}`, data };
    },
  },
  {
    name: "cyberboss_anniversary_count",
    description: "Calculate days since one anniversary and days until its next yearly occurrence.",
    inputSchema: objectSchema({
      id: { type: "string", description: "Anniversary id." },
      asOfDate: { type: "string", description: "Optional date in YYYY-MM-DD; defaults to today." },
    }, ["id"]),
    handler(services, args) {
      const data = services.anniversaries.getCount(args.id, { asOfDate: args.asOfDate });
      return { text: `${data.anniversary.name}: day ${data.daysSince}.`, data };
    },
  },
  {
    name: "cyberboss_daily_overview",
    description: "Read a combined daily overview with calendar status, festivals, dated todos, and anniversaries. Omit date for today.",
    inputSchema: objectSchema({
      date: { type: "string", description: "Optional date in YYYY-MM-DD; defaults to today." },
    }),
    handler(services, args) {
      const date = args.date || services.calendar.getToday().date;
      const data = services.overview.getDay(date);
      return {
        text: `Daily overview ${date}: ${data.todos.length} todos, ${data.anniversaries.length} anniversaries.`,
        data,
      };
    },
  },
];

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function formatCalendarDay(data) {
  const festivalNames = data.festivals.map((item) => item.name).join("、");
  const reason = data.officialHoliday?.name || festivalNames || data.workStatus;
  return `${data.date} ${data.weekdayName}: ${data.isWorkday ? "workday" : "off day"}${reason ? ` (${reason})` : ""}.`;
}

module.exports = { LifeCalendarToolHost };
