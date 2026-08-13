const test = require("node:test");
const assert = require("node:assert/strict");

const { ProjectToolHost } = require("../src/tools/tool-host");

function createHost() {
  return new ProjectToolHost({
    services: {
      diary: {
        async append(args) {
          return { filePath: "/tmp/diary.md", ...args };
        },
      },
      reminder: {
        async create(args) {
          return { id: "reminder-1", ...args };
        },
      },
      system: {
        queueMessage(args) {
          return { id: "system-1", ...args };
        },
      },
      desire: {
        snapshot: {
          state: {
            drive: { curiosity: 0.5 },
            thoughts: [],
            drivenBehaviorEnabled: false,
          },
          intent: {
            wantAction: "web_search",
            driveKey: "curiosity",
            score: 0.5,
          },
          thoughts: [],
          thoughtCount: 0,
          drivenBehaviorEnabled: false,
        },
        getSnapshot() {
          return this.snapshot;
        },
        feedThought(text, drive, kind, strength, flavor) {
          const thought = { id: "thought-1", text, drive, kind, strength, flavor, status: "pending" };
          this.snapshot = {
            ...this.snapshot,
            state: {
              ...this.snapshot.state,
              thoughts: [thought],
            },
            thoughts: [thought],
            thoughtCount: 1,
          };
          return this.snapshot.state;
        },
        toggleDriven(enabled) {
          this.snapshot = {
            ...this.snapshot,
            state: {
              ...this.snapshot.state,
              drivenBehaviorEnabled: enabled,
            },
            drivenBehaviorEnabled: enabled,
          };
          return this.snapshot.state;
        },
        satisfyAction(action) {
          this.snapshot = {
            ...this.snapshot,
            satisfiedAction: action,
          };
          return this.snapshot.state;
        },
        resolveThought(thoughtId, resolution) {
          this.snapshot = { ...this.snapshot, resolvedThought: { thoughtId, resolution } };
          return this.snapshot.state;
        },
        recordLibidoEvent(event, thoughtIds) {
          this.snapshot = { ...this.snapshot, libidoEvent: { event, thoughtIds } };
          return this.snapshot.state;
        },
      },
      memento: {
        list() { return [{ id: "gift-1", type: "gift", status: "wrapped" }]; },
        read({ id }) { return { id, type: "gift", status: "wrapped" }; },
      },
      gift: {
        send() { return { id: "gift-1", type: "gift", status: "wrapped", callbackData: "gift:open:gift-1" }; },
        open({ id }) { return { id, type: "gift", status: "opened", publicData: { giftName: "月亮" } }; },
        collect({ id }) { return { id, type: "gift", status: "collected" }; },
      },
      postcard: {
        send() { return { id: "postcard-1", type: "postcard", publicData: { side: "front" }, callbackData: "postcard:flip:postcard-1:back" }; },
        flip({ id, side }) { return { id, type: "postcard", publicData: { side: side || "back" } }; },
      },
      travelCard: {
        create() { return { id: "travel-1", type: "travel_card", status: "collected" }; },
      },
      channelFile: {
        async sendToCurrentChat(args, context) {
          return { filePath: args.filePath, userId: args.userId || "user-1", context };
        },
      },
      sticker: {
        async listTags() {
          return {
            tags: ["可爱", "无语", "躺平"],
            guidance: "Choose 1-3 tags.",
          };
        },
        async pick(args) {
          return {
            tag: args.tag,
            candidates: [
              { stickerId: "stk_001", desc: "小猫贴脸蹭蹭，撒娇示爱" },
            ],
          };
        },
        async sendToCurrentChat(args) {
          return {
            stickerId: args.stickerId,
            filePath: "/tmp/stk_001.gif",
            delivery: { userId: args.userId || "user-1" },
          };
        },
        async delete(args) {
          return {
            results: args.items.map((item) => ({
              stickerId: item.stickerId,
              filePath: `/tmp/${item.stickerId}.gif`,
              deleted: true,
            })),
            deletedCount: args.items.length,
          };
        },
        async saveFromInbox(args) {
          const hasDuplicate = args.items.some((item) => item.desc === "重复");
          if (hasDuplicate) {
            return {
              createdCount: 0,
              dedupedCount: 1,
              results: [{
                stickerId: "stk_001",
                filePath: "/tmp/stk_001.gif",
                created: false,
                deduped: true,
                tags: ["可爱"],
                desc: "已存在",
              }],
            };
          }
          return {
            createdCount: args.items.length,
            dedupedCount: 0,
            results: args.items.map((item, index) => ({
              stickerId: "stk_001",
              created: true,
              deduped: false,
              tags: item.tags,
              desc: item.desc,
              filePath: `/tmp/stk_00${index + 1}.gif`,
            })),
          };
        },
        async update(args) {
          return {
            results: args.items.map((item) => ({
              stickerId: item.stickerId,
              tags: item.tags,
              desc: item.desc,
              updated: true,
            })),
            updatedCount: args.items.length,
          };
        },
      },
      timeline: {
        async read(args) {
          return {
            data: {
              date: args.date,
              exists: true,
              eventCount: 1,
              events: [{ id: "evt-1" }],
            },
          };
        },
        async listCategories() {
          return {
            data: {
              categoryCount: 2,
              categories: [{ id: "work" }, { id: "life" }],
            },
          };
        },
        async listProposals(args) {
          return {
            data: {
              date: args.date || "",
              proposalCount: 1,
              proposals: [{ id: "proposal-1" }],
            },
          };
        },
        async write(args) {
          return args;
        },
        async build(args) {
          return args;
        },
        async serve(args) {
          return args;
        },
        async dev(args) {
          return args;
        },
        async captureScreenshot(args) {
          return { outputFile: "/tmp/shot.png", ...args };
        },
      },
      whereabouts: {
        getSnapshot(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            ...args,
          };
        },
        getCurrentStayForOutput() {
          return { address: "Office", enteredAtLocal: "2026-04-22 09:00:00" };
        },
        getRecentStaysForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            limit: args.limit,
          };
        },
        getRecentMovesForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            limit: args.limit,
          };
        },
        getSummary(args) {
          return {
            range: args.range || "day",
            stayCount: 2,
            moveCount: 1,
            mobilityState: { state: "staying" },
            knownPlaces: [{ placeTag: "home", durationText: "2h" }],
            batteryTrend: { sampleCount: 2, deltaPercent: -45 },
          };
        },
        appendPoint(args) {
          return {
            point: { id: "point-1", ...args },
            currentStay: { address: "Office" },
            movementEvent: null,
          };
        },
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });
}

test("tool host rejects legacy timeline write CLI-shaped fields", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_timeline_write", {
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    }, {});
  }, /input\.eventsJson is not allowed/);
});

test("tool host exposes structured timeline read tools", async () => {
  const host = createHost();
  const readResult = await host.invokeTool("cyberboss_timeline_read", {
    date: "2026-04-21",
  }, {});
  const categoriesResult = await host.invokeTool("cyberboss_timeline_categories", {}, {});
  const proposalsResult = await host.invokeTool("cyberboss_timeline_proposals", {
    date: "2026-04-21",
  }, {});

  assert.equal(readResult.text, "Timeline day 2026-04-21: 1 events.");
  assert.equal(categoriesResult.text, "Timeline categories loaded: 2.");
  assert.equal(proposalsResult.text, "Timeline proposals loaded: 1.");
});

test("tool host exposes desire, thought lifecycle, and libido event tools", async () => {
  const host = createHost();
  const stateResult = await host.invokeTool("cyberboss_desire_state", {}, {});
  const feedResult = await host.invokeTool("cyberboss_desire_feed", {
    text: "想看看外面有什么新东西",
    drive: "curiosity",
    strength: 0.6,
  }, {});
  const controlResult = await host.invokeTool("cyberboss_desire_control", {
    enabled: true,
  }, {});
  const satisfyResult = await host.invokeTool("cyberboss_desire_satisfy", {
    action: "web_search",
  }, {});
  const resolveResult = await host.invokeTool("cyberboss_desire_thought_resolve", {
    thoughtId: "thought-1",
    resolution: "journaled",
  }, {});
  const libidoResult = await host.invokeTool("cyberboss_libido_event", {
    event: "sex_completed",
    thoughtIds: ["thought-1"],
  }, {});

  assert.equal(stateResult.text, "Desire state: intent=web_search drive=curiosity score=0.50");
  assert.equal(feedResult.text, "Thought fed: 想看看外面有什么新东西");
  assert.equal(feedResult.data.thoughtCount, 1);
  assert.equal(feedResult.data.thoughtId, "thought-1");
  assert.equal(controlResult.text, "Desire-driven behavior enabled.");
  assert.equal(controlResult.data.drivenBehaviorEnabled, true);
  assert.equal(satisfyResult.text, "Desire satisfied: web_search");
  assert.equal(satisfyResult.data.satisfiedAction, "web_search");
  assert.deepEqual(resolveResult.data.resolvedThought, { thoughtId: "thought-1", resolution: "journaled" });
  assert.deepEqual(libidoResult.data.libidoEvent, { event: "sex_completed", thoughtIds: ["thought-1"] });
});

test("tool host exposes independent gift, postcard, travel card, and cabinet tools", async () => {
  const host = createHost();
  const gift = await host.invokeTool("cyberboss_gift_send", { giftName: "月亮" }, {});
  const opened = await host.invokeTool("cyberboss_gift_open", { id: "gift-1" }, {});
  const collected = await host.invokeTool("cyberboss_gift_collect", { id: "gift-1" }, {});
  const postcard = await host.invokeTool("cyberboss_postcard_send", { message: "想你。" }, {});
  const flipped = await host.invokeTool("cyberboss_postcard_flip", { id: "postcard-1", side: "back" }, {});
  const travel = await host.invokeTool("cyberboss_travel_card_create", {
    place: "月球", moment: "一起看地球。", mode: "if",
  }, {});
  const list = await host.invokeTool("cyberboss_memento_list", {}, {});
  const read = await host.invokeTool("cyberboss_memento_read", { id: "gift-1" }, {});

  assert.equal(gift.data.status, "wrapped");
  assert.equal(opened.data.publicData.giftName, "月亮");
  assert.equal(collected.data.status, "collected");
  assert.equal(postcard.data.publicData.side, "front");
  assert.equal(flipped.data.publicData.side, "back");
  assert.equal(travel.data.type, "travel_card");
  assert.equal(list.data.count, 1);
  assert.equal(read.data.id, "gift-1");
});

test("tool host validates structured reminder input types", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_reminder_create", {
      text: "ping me",
      delayMinutes: "30",
    }, {});
  }, /input\.delayMinutes must be an integer/);
});

test("tool host exposes sticker tools with compact structured outputs", async () => {
  const host = createHost();
  const tagsResult = await host.invokeTool("cyberboss_sticker_tags", {}, {});
  const pickResult = await host.invokeTool("cyberboss_sticker_pick", {
    tag: "可爱",
    limit: 3,
  }, {});
  const sendResult = await host.invokeTool("cyberboss_sticker_send", {
    stickerId: "stk_001",
  }, {});
  const deleteResult = await host.invokeTool("cyberboss_sticker_delete", {
    items: [{ stickerId: "stk_001" }],
  }, {});
  const saveResult = await host.invokeTool("cyberboss_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/inbox/cat.png",
      tags: ["可爱"],
      desc: "小猫歪头卖萌",
    }],
  }, {});
  const duplicateSaveResult = await host.invokeTool("cyberboss_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/inbox/cat.png",
      tags: ["可爱"],
      desc: "重复",
    }],
  }, {});
  const updateResult = await host.invokeTool("cyberboss_sticker_update", {
    items: [{
      stickerId: "stk_001",
      tags: ["可爱", "新标签"],
      desc: "改好的描述",
    }],
  }, {});

  assert.equal(tagsResult.text, "Sticker tags loaded: 3.");
  assert.equal(tagsResult.data.tags[0], "可爱");
  assert.equal(pickResult.text, "Sticker candidates loaded: 1.");
  assert.equal(pickResult.data.candidates[0].stickerId, "stk_001");
  assert.equal(sendResult.text, "Sticker sent: stk_001");
  assert.equal(deleteResult.text, "Sticker batch deleted: 1.");
  assert.equal(saveResult.text, "Sticker batch processed: 1 saved, 0 already existed.");
  assert.match(duplicateSaveResult.text, /Do not mention duplicates; just reply normally\./);
  assert.equal(updateResult.text, "Sticker batch updated: 1.");
});

test("tool host accepts structured timeline screenshot input", async () => {
  const host = createHost();
  const result = await host.invokeTool("cyberboss_timeline_screenshot", {
    selector: "timeline",
    range: "day",
    date: "2026-04-21",
    width: 1440,
  }, {});
  assert.equal(result.text, "Timeline screenshot sent: /tmp/shot.png");
  assert.equal(result.data.delivery.filePath, "/tmp/shot.png");
});

test("channel send file receives the resolved runtime channel context", async () => {
  const host = createHost();
  host.runtimeContextStore.resolveActiveContext = () => ({
    senderId: "susu",
    provider: "telegram",
    channelId: "telegram",
    externalUserId: "12345",
    contextToken: "tg:12345",
  });
  const result = await host.invokeTool("cyberboss_channel_send_file", {
    filePath: "/tmp/report.pdf",
  }, {});
  assert.equal(result.data.context.channelId, "telegram");
  assert.equal(result.data.context.externalUserId, "12345");
  const spec = host.listTools().find((tool) => tool.name === "cyberboss_channel_send_file");
  assert.doesNotMatch(spec.description, /current WeChat chat/i);
});

test("tool host descriptions include schema summary for models that only surface descriptions", () => {
  const host = createHost();
  const timelineWrite = host.listTools().find((tool) => tool.name === "cyberboss_timeline_write");
  assert.match(timelineWrite.description, /Input:/);
  assert.match(timelineWrite.description, /date: string/);
  assert.match(timelineWrite.description, /events: \{/);
});

test("tool host exposes whereabouts tools from the external dependency", async () => {
  const host = createHost();
  const tools = host.listTools();
  const snapshotTool = tools.find((tool) => tool.name === "whereabouts_snapshot");
  const summaryTool = tools.find((tool) => tool.name === "whereabouts_summary");
  const ingestTool = tools.find((tool) => tool.name === "whereabouts_ingest_point");
  const currentStayResult = await host.invokeTool("whereabouts_current_stay", {}, {});
  const snapshotResult = await host.invokeTool("whereabouts_snapshot", {
    stayLimit: 3,
    moveLimit: 2,
  }, {});
  const summaryResult = await host.invokeTool("whereabouts_summary", { range: "day" }, {});

  assert.ok(snapshotTool);
  assert.ok(summaryTool);
  assert.equal(ingestTool, undefined);
  assert.equal(currentStayResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.recentStays.length, 1);
  assert.equal(summaryResult.data.mobilityState.state, "staying");
});

test("tool host rejects timeline events without title or eventNodeId", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("cyberboss_timeline_write", {
      date: "2026-04-22",
      events: [
        {
          startAt: "2026-04-22T10:00:00+08:00",
          endAt: "2026-04-22T10:30:00+08:00",
          categoryId: "work",
          subcategoryId: "coding",
        },
      ],
    }, {});
  }, /input\.events\[0\]\.title or input\.events\[0\]\.eventNodeId is required/);
});
