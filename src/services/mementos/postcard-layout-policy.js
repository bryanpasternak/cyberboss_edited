const POSTCARD_LAYOUTS = Object.freeze({
  ONE_LINE: "one_line",
  SHORT_NOTE: "short_note",
  LONG_LETTER: "long_letter",
});

const LAYOUT_ORDER = [
  POSTCARD_LAYOUTS.ONE_LINE,
  POSTCARD_LAYOUTS.SHORT_NOTE,
  POSTCARD_LAYOUTS.LONG_LETTER,
];

const LAYOUT_LIMITS = Object.freeze({
  [POSTCARD_LAYOUTS.ONE_LINE]: 45,
  [POSTCARD_LAYOUTS.SHORT_NOTE]: 180,
  [POSTCARD_LAYOUTS.LONG_LETTER]: Number.POSITIVE_INFINITY,
});

function choosePostcardLayout(message, requestedLayout = "auto") {
  const textLength = countGraphemes(message);
  const automatic = textLength <= LAYOUT_LIMITS[POSTCARD_LAYOUTS.ONE_LINE]
    ? POSTCARD_LAYOUTS.ONE_LINE
    : textLength <= LAYOUT_LIMITS[POSTCARD_LAYOUTS.SHORT_NOTE]
      ? POSTCARD_LAYOUTS.SHORT_NOTE
      : POSTCARD_LAYOUTS.LONG_LETTER;
  const requested = normalizeLayout(requestedLayout);
  if (!requested || requested === "auto") return { layout: automatic, textLength };
  return {
    layout: layoutRank(requested) < layoutRank(automatic) ? automatic : requested,
    textLength,
  };
}

function nextPostcardLayout(layout) {
  const index = LAYOUT_ORDER.indexOf(normalizeLayout(layout));
  if (index < 0 || index >= LAYOUT_ORDER.length - 1) return POSTCARD_LAYOUTS.LONG_LETTER;
  return LAYOUT_ORDER[index + 1];
}

function countGraphemes(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return 0;
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
    return Array.from(segmenter.segment(normalized)).length;
  }
  return Array.from(normalized).length;
}

function normalizeLayout(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized || normalized === "auto") return "auto";
  return LAYOUT_ORDER.includes(normalized) ? normalized : "auto";
}

function layoutRank(layout) {
  const index = LAYOUT_ORDER.indexOf(layout);
  return index < 0 ? 0 : index;
}

module.exports = {
  LAYOUT_LIMITS,
  POSTCARD_LAYOUTS,
  choosePostcardLayout,
  countGraphemes,
  nextPostcardLayout,
  normalizeLayout,
};
