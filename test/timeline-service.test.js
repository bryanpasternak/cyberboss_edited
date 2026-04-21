const test = require("node:test");
const assert = require("node:assert/strict");

const { TimelineService } = require("../src/services/timeline-service");

function createService() {
  const calls = [];
  const service = new TimelineService({
    config: {
      stateDir: "/tmp/cyberboss-state",
      timelineScreenshotQueueFile: "/tmp/cyberboss-timeline-service-test.json",
    },
    timelineIntegration: {
      async runSubcommand(subcommand, args) {
        calls.push({ subcommand, args });
        if (subcommand === "serve") {
          return { url: "http://127.0.0.1:4317" };
        }
        if (subcommand === "dev") {
          return { url: "http://127.0.0.1:4318" };
        }
        return {};
      },
    },
    sessionStore: {
      listBindings() {
        return [];
      },
    },
  });
  return { service, calls };
}

test("timeline service serializes structured events into timeline JSON payload", async () => {
  const { service, calls } = createService();
  await service.write({
    date: "2026-04-21",
    events: [
      {
        startAt: "2026-04-21T02:00:00+08:00",
        endAt: "2026-04-21T03:10:00+08:00",
        categoryId: "work",
        subcategoryId: "coding",
        description: "project tools refactor",
      },
    ],
  });

  assert.deepEqual(calls, [
    {
      subcommand: "write",
      args: [
        "--date", "2026-04-21",
        "--events-json", JSON.stringify({
          events: [
            {
              startAt: "2026-04-21T02:00:00+08:00",
              endAt: "2026-04-21T03:10:00+08:00",
              categoryId: "work",
              subcategoryId: "coding",
              description: "project tools refactor",
            },
          ],
        }),
      ],
    },
  ]);
});

test("timeline service rejects mixed structured and raw event sources", async () => {
  const { service } = createService();
  await assert.rejects(async () => {
    await service.write({
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    });
  }, /Use only one of events, eventsJson, or eventsFile/);
});

test("timeline service serializes structured screenshot options", async () => {
  const { service, calls } = createService();
  const result = await service.captureScreenshot({
    outputFile: "/tmp/timeline-shot.png",
    selector: "analytics",
    range: "day",
    date: "2026-04-21",
    category: "work",
    subcategory: "coding",
    width: 1440,
    height: 1200,
    sidePadding: 24,
    locale: "zh-CN",
  });

  assert.equal(result.outputFile, "/tmp/timeline-shot.png");
  assert.deepEqual(calls, [
    {
      subcommand: "screenshot",
      args: [
        "--output", "/tmp/timeline-shot.png",
        "--selector", "analytics",
        "--range", "day",
        "--date", "2026-04-21",
        "--category", "work",
        "--subcategory", "coding",
        "--width", "1440",
        "--height", "1200",
        "--side-padding", "24",
        "--locale", "zh-CN",
      ],
    },
  ]);
});

test("timeline service returns serve startup url", async () => {
  const { service } = createService();
  const result = await service.serve({ locale: "zh-CN" });
  assert.equal(result.url, "http://127.0.0.1:4317");
});

test("timeline service returns dev startup url", async () => {
  const { service } = createService();
  const result = await service.dev({ locale: "zh-CN" });
  assert.equal(result.url, "http://127.0.0.1:4318");
});
