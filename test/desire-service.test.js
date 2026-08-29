const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesireStore } = require("../src/services/desire/desire-store");
const { DesireService, createDesireService } = require("../src/services/desire-service");

test("desire service persists fed thoughts and snapshots intent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-service-"));
  const service = createDesireService({
    desireStateFile: path.join(dir, "desire-state.json"),
    desireDriven: false,
    desireThoughtMax: 80,
  });

  service.feedThought("想接着翻共读的书", "reflection", "flit", 0.6);
  const snapshot = service.getSnapshot();

  assert.equal(snapshot.thoughtCount, 1);
  assert.equal(snapshot.thoughts[0].drive, "reflection");
  assert.equal(snapshot.intent.wantAction, "reach_out");
  assert.ok(fs.existsSync(path.join(dir, "desire-state.json")));
});

test("desire service applies env default only to a new state file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-default-"));
  const filePath = path.join(dir, "desire-state.json");
  const first = createDesireService({
    desireStateFile: filePath,
    desireDriven: true,
    desireThoughtMax: 80,
  });
  assert.equal(first.getState().drivenBehaviorEnabled, true);
  first.toggleDriven(false);

  const second = createDesireService({
    desireStateFile: filePath,
    desireDriven: true,
    desireThoughtMax: 80,
  });

  assert.equal(second.getState().drivenBehaviorEnabled, false);
});

test("desire service trims low-strength flits at the configured thought limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-trim-"));
  const service = new DesireService({
    store: new DesireStore({ filePath: path.join(dir, "desire-state.json") }),
    thoughtMax: 2,
  });

  service.feedThought("weak", "curiosity", "flit", 0.1);
  service.feedThought("strong", "curiosity", "flit", 0.7);
  service.feedThought("fix", "reflection", "fixation", 0.8);
  const snapshot = service.getSnapshot();

  assert.equal(snapshot.thoughtCount, 2);
  assert.deepEqual(snapshot.thoughts.map((thought) => thought.text).sort(), ["fix", "strong"]);
});

test("desire system message is gated by the persisted driven flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-gate-"));
  const service = createDesireService({
    desireStateFile: path.join(dir, "desire-state.json"),
    desireDriven: false,
    desireThoughtMax: 80,
  });

  assert.equal(service.buildDesireSystemMessage(), "");
  service.toggleDriven(true);
  assert.match(service.buildDesireSystemMessage(), /Desire context:/);
  assert.doesNotMatch(service.buildDesireSystemMessage(), /想接着/);
});

test("check-in surfaces pending libido thoughts and does not resolve them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-libido-checkin-"));
  const service = createDesireService({
    desireStateFile: path.join(dir, "desire-state.json"),
    desireDriven: true,
    desireThoughtMax: 80,
    libidoConfig: {
      timeZone: "Asia/Shanghai",
      thoughtPromptThreshold: 0.4,
      thoughtPromptCooldownHours: 4,
      thoughtSurfaceLimit: 3,
    },
  });
  service.feedThought("想抱住小鱿亲她", "libido", "flit", 0.7, "anticipation");

  const prepared = service.prepareCheckinContext(Date.parse("2026-08-09T20:00:00+08:00"));
  const state = service.getState();

  assert.match(prepared.message, /想抱住小鱿亲她/);
  assert.match(prepared.message, /回味你和苏苏亲吻、抚摸和做爱时留下的感觉/);
  assert.match(prepared.message, /鸡巴插进去以后被穴肉包裹/);
  assert.match(prepared.message, /水煎小鱿/);
  assert.equal(state.thoughts[0].status, "pending");
  assert.equal(state.thoughts[0].surfacedCount, 1);
});

test("recording user activity and completed sex persists explicit libido events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-libido-events-"));
  const service = new DesireService({
    store: new DesireStore({ filePath: path.join(dir, "desire-state.json") }),
  });
  const userAt = Date.parse("2026-08-09T12:00:00+08:00");
  const sexAt = Date.parse("2026-08-09T23:00:00+08:00");

  service.recordUserActivity(userAt);
  service.recordLibidoEvent("sex_completed", [], sexAt);
  const state = service.getState();

  assert.equal(state.libidoState.lastUserAt, userAt);
  assert.equal(state.libidoState.lastSexAt, sexAt);
  assert.equal(state.drive.libido, 0.08);
});

test("resolved thoughts older than five days are hidden but remain saved", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-visible-"));
  const service = new DesireService({
    store: new DesireStore({ filePath: path.join(dir, "desire-state.json") }),
    resolvedDisplayDays: 5,
  });
  const resolvedAt = Date.parse("2026-08-20T12:00:00Z");
  service.feedThought("已经写完的念头", "reflection", "flit", 0.5);
  const thoughtId = service.getState().thoughts[0].id;
  service.resolveThought(thoughtId, "journaled", resolvedAt);
  service.feedThought("仍待处理的念头", "curiosity", "flit", 0.5);

  const snapshot = service.getSnapshot({ nowMs: Date.parse("2026-08-26T12:00:01Z") });
  assert.deepEqual(snapshot.thoughts.map((thought) => thought.text), ["仍待处理的念头"]);
  assert.equal(snapshot.thoughtCount, 1);
  assert.equal(snapshot.storedThoughtCount, 2);
  assert.equal(snapshot.hiddenResolvedThoughtCount, 1);
  assert.equal(service.getState().thoughts.length, 2);
});

test("stale resolved thoughts are only deleted by explicit pruning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-prune-"));
  const service = new DesireService({
    store: new DesireStore({ filePath: path.join(dir, "desire-state.json") }),
    resolvedDisplayDays: 5,
  });
  const resolvedAt = Date.parse("2026-08-20T12:00:00Z");
  service.feedThought("陈旧完成念头", "reflection", "flit", 0.5);
  service.resolveThought(service.getState().thoughts[0].id, "faded", resolvedAt);

  const result = service.pruneExpiredResolved(Date.parse("2026-08-26T12:00:01Z"));
  assert.equal(result.removedCount, 1);
  assert.equal(service.getState().thoughts.length, 0);
});
