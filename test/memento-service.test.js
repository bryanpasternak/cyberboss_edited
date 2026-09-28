const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { createMementoServices } = require("../src/services/mementos");

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-mementos-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const services = createMementoServices({ mementoDir: root }, options);
  services.fixtureRoot = root;
  return services;
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

test("illustrated postcard pauses for agent art and finalizes to persistent PNG assets", async (t) => {
  const renderedLayouts = [];
  const services = createFixture(t, {
    postcardHtmlRenderer: fakeHtmlRenderer(({ record }) => {
      renderedLayouts.push(record.data.appearance.layout);
      return fakeRenderedPair();
    }),
  });
  const privateMessage = "今晚的月亮经过海面时，我又想抱你了。";
  const draft = await services.postcard.prepare({
    message: privateMessage,
    visualBrief: "深夜海面、月亮与一颗沿轨道靠近的小卫星",
    frontTitle: "今晚忽然很想你",
  });
  assert.equal(draft.status, "awaiting_art");
  assert.equal(draft.publicData.appearance.layout, "one_line");
  assert.equal(draft.displayAsset, null);
  assert.match(draft.artRequest.prompt, /深夜海面/);
  assert.doesNotMatch(draft.artRequest.prompt, new RegExp(privateMessage));

  const sourceImagePath = path.join(services.fixtureRoot, "generated-art.png");
  await sharp({ create: { width: 256, height: 192, channels: 3, background: "#18283c" } })
    .png()
    .toFile(sourceImagePath);
  const front = await services.postcard.finalize({ id: draft.id, sourceImagePath });
  assert.equal(front.status, "sent");
  assert.equal(front.displayAsset.mimeType, "image/png");
  assert.ok(fs.existsSync(front.displayAsset.filePath));
  assert.deepEqual(renderedLayouts, ["one_line"]);

  const back = services.postcard.flip({ id: draft.id, side: "back", actorId: "susu" });
  assert.equal(back.publicData.message, privateMessage);
  assert.equal(back.displayAsset.mimeType, "image/png");
  assert.ok(fs.existsSync(back.displayAsset.filePath));
});

test("fixed postcard automatically upgrades its layout instead of clipping text", async (t) => {
  const renderedLayouts = [];
  const services = createFixture(t, {
    postcardHtmlRenderer: fakeHtmlRenderer(({ record }) => {
      const layout = record.data.appearance.layout;
      renderedLayouts.push(layout);
      return fakeRenderedPair({ overflow: layout === "one_line" });
    }),
  });
  const draft = await services.postcard.prepare({
    message: "想你。",
    visualBrief: "一弯月亮落在安静的深蓝海面",
  });
  const front = await services.postcard.finalize({ id: draft.id, useFallback: true });
  assert.deepEqual(renderedLayouts, ["one_line", "short_note"]);
  assert.equal(front.publicData.appearance.layout, "short_note");
  assert.equal(front.publicData.appearance.renderer, "html-postcard");
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

function fakeHtmlRenderer(render) {
  return { async render(input) { return await render(input); } };
}

function fakeRenderedPair({ overflow = false } = {}) {
  return {
    front: { buffer: Buffer.from("front-png"), width: 1800, height: 1200, overflow },
    back: { buffer: Buffer.from("back-png"), width: 1800, height: 1200, overflow: false },
    overflow,
  };
}
