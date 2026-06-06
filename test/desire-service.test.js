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
  assert.equal(snapshot.intent.wantAction, "none");
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
