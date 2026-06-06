const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createDefaultState,
  tick,
  computeScores,
  pickIntent,
  satisfy,
  feedThought,
  sourceDriveFor,
  FATIGUE_REST_GATE,
} = require("../src/services/desire/desire-engine");

test("desire intent chooses the strongest non-fatigue drive", () => {
  const state = createDefaultState(1000);
  state.drive.curiosity = 0.91;
  state.drive.attachment = 0.4;

  const intent = pickIntent(state);

  assert.equal(intent.driveKey, "curiosity");
  assert.equal(intent.wantAction, "web_search");
  assert.equal(intent.score, 0.91);
});

test("fatigue gates active desire into rest", () => {
  const state = createDefaultState(1000);
  state.drive.fatigue = FATIGUE_REST_GATE;
  state.drive.curiosity = 0.99;

  const intent = pickIntent(state);

  assert.equal(intent.driveKey, "fatigue");
  assert.equal(intent.wantAction, "none");
});

test("fixations boost scores and feed back into drives during ticks", () => {
  let state = createDefaultState(1000);
  state = feedThought(state, {
    text: "想继续翻那段共读笔记",
    drive: "reflection",
    kind: "fixation",
    strength: 0.9,
  });
  const scores = computeScores(state.drive, state.thoughts);
  assert.ok(scores.reflection > state.drive.reflection);

  const next = tick(state, 2000);
  assert.ok(next.drive.reflection > state.drive.reflection);
  assert.equal(next.thoughts[0].fedCount, 1);
});

test("satisfy applies action-specific multiplicative decay", () => {
  const state = createDefaultState(1000);
  state.drive.libido = 0.8;
  state.drive.attachment = 0.5;

  const next = satisfy(state, "tease");

  assert.equal(next.drive.libido, 0.44);
  assert.equal(next.drive.attachment, 0.39);
});

test("repeated feed strengthens the same thought and can promote fixation", () => {
  let state = createDefaultState(1000);
  state = feedThought(state, {
    text: "想看看外面有什么新东西",
    drive: "curiosity",
    kind: "flit",
    strength: 0.45,
  });
  state = feedThought(state, {
    text: "想看看外面有什么新东西",
    drive: "curiosity",
    kind: "flit",
    strength: 0.4,
  });

  assert.equal(state.thoughts.length, 1);
  assert.equal(state.thoughts[0].kind, "fixation");
  assert.equal(state.thoughts[0].strength, 0.85);
});

test("sourceDriveFor reverse-maps external action sources", () => {
  assert.equal(sourceDriveFor("co_read"), "reflection");
  assert.equal(sourceDriveFor("web_browse"), "social");
  assert.equal(sourceDriveFor("github"), "curiosity");
  assert.equal(sourceDriveFor("unknown"), "");
});
