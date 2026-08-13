const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createMementoServices } = require("../src/services/mementos");

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mementos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return createMementoServices({ mementoDir: root });
}

test("gift stays secret until opened and can be collected", (t) => {
  const services = createFixture(t);
  const wrapped = services.gift.send({
    giftName: "一枚月亮胸针",
    description: "银色的小月亮",
    letter: "哥哥想把它别在小鱿胸前。",
    teaser: "摇起来没有声音",
  });

  assert.equal(wrapped.status, "wrapped");
  assert.equal(wrapped.publicData.giftName, undefined);
  assert.equal(wrapped.publicData.letter, undefined);
  assert.match(wrapped.callbackData, /^gift:open:gift_/);
  assert.ok(fs.existsSync(wrapped.displayAsset.filePath));

  const opened = services.gift.open({ id: wrapped.id, actorId: "susu" });
  assert.equal(opened.status, "opened");
  assert.equal(opened.publicData.giftName, "一枚月亮胸针");
  assert.equal(opened.publicData.letter, "哥哥想把它别在小鱿胸前。");
  assert.ok(fs.existsSync(opened.displayAsset.filePath));
  assert.match(opened.callbackData, /^gift:collect:gift_/);

  const collected = services.gift.collect({ id: wrapped.id, actorId: "susu" });
  assert.equal(collected.status, "collected");
  assert.deepEqual(collected.availableActions, []);
});

test("postcard has persistent front and back assets", (t) => {
  const services = createFixture(t);
  const front = services.postcard.send({
    from: "卫星",
    to: "苏苏",
    message: "今天也想到小鱿了。",
    frontTitle: "月亮背面",
  });
  assert.equal(front.publicData.side, "front");
  assert.ok(fs.existsSync(front.displayAsset.filePath));
  assert.match(front.callbackData, /:back$/);

  const back = services.postcard.flip({ id: front.id, side: "back", actorId: "susu" });
  assert.equal(back.publicData.side, "back");
  assert.equal(back.publicData.message, "今天也想到小鱿了。");
  assert.ok(fs.existsSync(back.displayAsset.filePath));
  assert.match(back.callbackData, /:front$/);
});

test("travel cards preserve real, imagined, and IF provenance", (t) => {
  const services = createFixture(t);
  const card = services.travelCard.create({
    place: "厦门海边",
    moment: "风把小鱿脸旁的短发吹开了。",
    companions: ["苏苏", "卫星"],
    mode: "imagined",
  });
  assert.equal(card.status, "collected");
  assert.equal(card.publicData.mode, "imagined");
  assert.deepEqual(card.publicData.companions, ["苏苏", "卫星"]);
  assert.ok(fs.existsSync(card.displayAsset.filePath));
});

test("shared cabinet lists type-specific public views", (t) => {
  const services = createFixture(t);
  const gift = services.gift.send({ giftName: "秘密礼物" });
  services.postcard.send({ message: "寄给你。" });
  services.travelCard.create({ place: "月球", moment: "一起看地球。", mode: "if" });

  const all = services.memento.list({ viewerId: "susu" });
  assert.equal(all.length, 3);
  const wrappedGift = all.find((item) => item.id === gift.id);
  assert.equal(wrappedGift.publicData.giftName, undefined);
  assert.deepEqual(new Set(all.map((item) => item.type)), new Set(["gift", "postcard", "travel_card"]));
});
