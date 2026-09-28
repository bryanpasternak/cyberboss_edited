const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { HtmlImageRenderer, discoverBrowserExecutable } = require("../src/services/mementos/renderers/html-image-renderer");
const { HtmlPostcardRenderer } = require("../src/services/mementos/renderers/html-postcard-renderer");

const browserExecutable = discoverBrowserExecutable();

test("HTML postcard renderer produces fixed cover and growing long-letter PNG", {
  skip: browserExecutable ? false : "No local Edge/Chrome executable",
  timeout: 60_000,
}, async () => {
  const renderer = new HtmlPostcardRenderer({
    imageRenderer: new HtmlImageRenderer({ browserExecutable, deviceScaleFactor: 1 }),
  });
  const record = {
    type: "postcard",
    data: {
      from: "卫星",
      to: "苏苏",
      date: "2026-08-30",
      frontTitle: "八月末的一封信",
      frontCaption: "给我最想共同生活的人",
      stamp: "月亮邮票",
      message: Array.from({ length: 14 }, (_, index) => `第${index + 1}段：我想把普通的日子，也一张张留给你。`).join("\n\n"),
      appearance: { layout: "long_letter" },
    },
  };
  const result = await renderer.render({ record });
  const front = await sharp(result.front.buffer).metadata();
  const back = await sharp(result.back.buffer).metadata();
  assert.equal(front.width, 900);
  assert.equal(front.height, 600);
  assert.equal(back.width, 900);
  assert.ok(back.height > 600);
  assert.equal(result.overflow, false);
});
