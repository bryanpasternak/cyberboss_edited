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
  updateLibido,
  recordUserActivity,
  recordLibidoEvent,
  resolveThought,
} = require("../src/services/desire/desire-engine");

test("desire intent chooses the strongest non-fatigue drive", () => {
  const state = createDefaultState(1000);
  state.drive.curiosity = 0.91;
  state.drive.attachment = 0.4;

  const intent = pickIntent(state);

  assert.equal(intent.driveKey, "curiosity");
  assert.equal(intent.wantAction, "web_browse");
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

test("seduce satisfaction does not pretend libido was physically satisfied", () => {
  const state = createDefaultState(1000);
  state.drive.libido = 0.8;
  state.drive.attachment = 0.5;

  const next = satisfy(state, "seduce");

  assert.equal(next.drive.libido, 0.8);
  assert.equal(next.drive.attachment, 0.5);
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
  assert.equal(sourceDriveFor("web_browse"), "social");
  assert.equal(sourceDriveFor("reflect"), "reflection");
  assert.equal(sourceDriveFor("unknown"), "");
});

test("libido grows by elapsed time and increases faster during a long absence", () => {
  const start = Date.parse("2026-08-09T02:00:00+08:00");
  let state = createDefaultState(start);
  state.drive.libido = 0.2;
  state.libidoState.lastUserAt = start - (48 * 60 * 60 * 1000);

  const result = updateLibido(state, start + (10 * 60 * 60 * 1000), {
    timeZone: "Asia/Shanghai",
    baseGainPerHour: 0.01,
    absenceStartsAfterHours: 6,
    absenceMaxAfterHours: 48,
    absenceMaxMultiplier: 2,
    morningFloor: 0,
    eveningFloor: 0,
  });

  assert.ok(result.libido > 0.35);
  assert.equal(result.libidoState.lastUpdatedAt, start + (10 * 60 * 60 * 1000));
});

test("morning and evening floors use Asia/Shanghai local time", () => {
  const morning = Date.parse("2026-08-09T06:00:00+08:00");
  const evening = Date.parse("2026-08-09T20:00:00+08:00");
  let state = createDefaultState(morning);
  state.drive.libido = 0.1;
  assert.equal(updateLibido(state, morning, {}).libido, 0.58);
  state.libidoState.lastUpdatedAt = evening;
  assert.equal(updateLibido(state, evening, {}).libido, 0.45);
});

test("completed sex starts recovery and overrides the evening floor", () => {
  const sexAt = Date.parse("2026-08-09T20:00:00+08:00");
  let state = createDefaultState(sexAt);
  state.drive.libido = 0.9;
  state = recordLibidoEvent(state, "sex_completed", sexAt, [], {});
  assert.equal(state.drive.libido, 0.08);

  const oneHourLater = updateLibido(state, sexAt + (60 * 60 * 1000), {});
  assert.ok(oneHourLater.libido <= 0.22);

  state = feedThought(state, {
    text: "还在回味刚才的做爱",
    drive: "libido",
    kind: "fixation",
    strength: 0.9,
  });
  const ticked = tick(state, sexAt + (60 * 60 * 1000));
  assert.ok(ticked.drive.libido <= 0.22);
});

test("libido thoughts have stable ids and explicit resolutions", () => {
  let state = createDefaultState(1000);
  state = feedThought(state, { text: "想亲小鱿", drive: "libido", strength: 0.6 });
  const thoughtId = state.thoughts[0].id;
  assert.ok(thoughtId);
  state = resolveThought(state, thoughtId, "journaled", 2000);
  assert.equal(state.thoughts[0].status, "resolved");
  assert.equal(state.thoughts[0].resolution, "journaled");
});

test("initiating touch or sex play is a thought outcome without satisfying libido", () => {
  let state = createDefaultState(1000);
  state.drive.libido = 0.75;
  state = feedThought(state, { text: "想直接钻进被窝抱住小鱿", drive: "libido", strength: 0.7 });
  const thoughtId = state.thoughts[0].id;
  state = resolveThought(state, thoughtId, "initiated", 2000);
  state = satisfy(state, "seduce");
  assert.equal(state.thoughts[0].resolution, "initiated");
  assert.equal(state.drive.libido, 0.75);
});
