const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const { parseTex, pdfPageParagraphs, parsePdfInfo, normalizeMathGlyphs, bibliographyParagraphs } = require("../lib/paper");
const { paragraphText } = require("../lib/content");

test("paper content keeps legacy string paragraphs compatible", () => {
  assert.equal(paragraphText("普通段落"), "普通段落");
  assert.equal(paragraphText({ kind: "rich", text: "$x^2$", html: "<math></math>" }), "$x^2$");
});

test("PDF metadata and page text are normalized", () => {
  assert.deepEqual(parsePdfInfo("Title: Demo\nAuthor: Su\nPages: 2\n"), {
    title: "Demo",
    author: "Su",
    pages: "2",
  });
  assert.deepEqual(pdfPageParagraphs("First wrapped\nline.\n\nSecond para-\ngraph."), [
    "First wrapped line.",
    "Second paragraph.",
  ]);
});

test("math alphabet glyphs keep their variant without relying on rare fonts", () => {
  assert.equal(
    normalizeMathGlyphs("<mi>𝔼</mi><mi>𝒳</mi>"),
    '<mi mathvariant="double-struck">E</mi><mi mathvariant="script">X</mi>'
  );
});

test("BibTeX's leading item count is not shown as a reference", () => {
  assert.deepEqual(bibliographyParagraphs("94\n\nFirst reference.\n\nSecond\nreference."), [
    "First reference.",
    "Second reference.",
  ]);
});

const pandocAvailable = spawnSync(process.env.READING_PANDOC_PATH || "pandoc", ["--version"], { windowsHide: true }).status === 0;

test("TeX becomes responsive rich blocks while preserving LaTeX for AI", { skip: !pandocAvailable }, () => {
  const source = String.raw`\documentclass{article}
\title{Tiny Paper}
\author{Su Su}
\begin{document}
\maketitle
\section{Method}
We optimize $E=mc^2$ during training.
\[
  \mathcal{L} = -\sum_i y_i \log p_i
\]
\end{document}`;
  const parsed = parseTex(Buffer.from(source), { fallbackTitle: "fallback" });
  assert.equal(parsed.contentKind, "paper-tex");
  assert.equal(parsed.metadata.title, "Tiny Paper");
  const values = parsed.sections.flatMap((section) => section.blocks);
  const rich = values.filter((value) => value && typeof value === "object");
  assert.ok(rich.length >= 1);
  assert.ok(rich.some((value) => value.html.includes("<math")));
  assert.ok(values.map(paragraphText).join("\n").includes("$E=mc^2$"));
  assert.ok(values.map(paragraphText).join("\n").includes("\\mathcal{L}"));
});
