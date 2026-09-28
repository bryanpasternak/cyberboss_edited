const test = require("node:test");
const assert = require("node:assert/strict");

const {
  choosePostcardLayout,
  countGraphemes,
  nextPostcardLayout,
} = require("../src/services/mementos/postcard-layout-policy");

test("postcard layout policy uses the agreed fixed-card budgets", () => {
  assert.equal(choosePostcardLayout("想".repeat(45)).layout, "one_line");
  assert.equal(choosePostcardLayout("想".repeat(46)).layout, "short_note");
  assert.equal(choosePostcardLayout("想".repeat(180)).layout, "short_note");
  assert.equal(choosePostcardLayout("想".repeat(181)).layout, "long_letter");
});

test("postcard layout policy counts graphemes and never forces a smaller requested layout", () => {
  assert.equal(countGraphemes("👩‍❤️‍💋‍👨"), 1);
  assert.equal(choosePostcardLayout("长".repeat(181), "one_line").layout, "long_letter");
  assert.equal(choosePostcardLayout("短笺", "long_letter").layout, "long_letter");
  assert.equal(nextPostcardLayout("one_line"), "short_note");
  assert.equal(nextPostcardLayout("short_note"), "long_letter");
});
