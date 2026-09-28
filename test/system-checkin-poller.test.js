const test = require("node:test");
const assert = require("node:assert/strict");

const { buildModeReminder } = require("../src/app/system-checkin-poller");

test("world-wander check-in offers a bounded read-only Xiaohongshu stroll", () => {
  const reminder = buildModeReminder("world_wander");

  assert.match(reminder, /卫星捡贝壳/);
  assert.match(reminder, /--limit 5/);
  assert.match(reminder, /一次 check-in 最多读取一次 feed/);
  assert.match(reminder, /不要点赞、收藏、关注、评论或私信/);
  assert.match(reminder, /失败或超时就停下且不重试/);
  assert.match(reminder, /cyberboss_desire_feed/);
});
