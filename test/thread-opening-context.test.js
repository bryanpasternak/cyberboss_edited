const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("new-thread recap can be disabled without disabling recent memory injection", async () => {
  let recapCalls = 0;
  let recentCalls = 0;
  const appLike = {
    config: { chatMemoryThreadRecapEnabled: false },
    chatMemory: {
      memory: {
        async buildThreadRecap() {
          recapCalls += 1;
          return "previous thread recap";
        },
        async retrieveRecent() {
          recentCalls += 1;
          return [{ id: "memory-1" }];
        },
        formatForInjection() {
          return "recent memory context";
        },
      },
    },
  };

  const context = await CyberbossApp.prototype.buildNewThreadOpeningContext.call(appLike, {
    previousThreadId: "thread-1",
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(recapCalls, 0);
  assert.equal(recentCalls, 1);
  assert.equal(context, "recent memory context");
});

test("new-thread recap remains enabled by default", async () => {
  let recapCalls = 0;
  const appLike = {
    config: {},
    chatMemory: {
      memory: {
        async buildThreadRecap() {
          recapCalls += 1;
          return "previous thread recap";
        },
        async retrieveRecent() {
          return [];
        },
        formatForInjection() {
          return "";
        },
      },
    },
  };

  const context = await CyberbossApp.prototype.buildNewThreadOpeningContext.call(appLike, {
    previousThreadId: "thread-1",
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(recapCalls, 1);
  assert.equal(context, "previous thread recap");
});
