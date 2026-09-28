const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { cleanText } = require("./epub");

const MAX_TOOL_OUTPUT = 128 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 2 * 60 * 1000;

function runTool(command, args, { input, cwd } = {}) {
  const result = spawnSync(command, args, {
    input,
    cwd,
    encoding: input === undefined || typeof input === "string" ? "utf8" : undefined,
    maxBuffer: MAX_TOOL_OUTPUT,
    timeout: TOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`缺少论文转换工具 ${command}；请安装后重试或设置对应 PATH`);
    }
    throw new Error(`${command} 运行失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
    throw new Error(`${command} 运行失败：${stderr.trim() || `退出码 ${result.status}`}`);
  }
  return result.stdout;
}

function pandocCommand() {
  return String(process.env.READING_PANDOC_PATH || "pandoc");
}

function metaText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.t === "MetaString") return String(value.c || "");
  if (value.t === "MetaInlines") return inlineText(value.c || []);
  if (value.t === "MetaBlocks") return blocksText(value.c || []);
  if (value.t === "MetaList") return (value.c || []).map(metaText).filter(Boolean).join(", ");
  return "";
}

function commandArgument(source, command) {
  const marker = `\\${command}{`;
  const start = String(source || "").indexOf(marker);
  if (start < 0) return "";
  let depth = 1;
  let out = "";
  for (let i = start + marker.length; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{" && source[i - 1] !== "\\") depth += 1;
    if (char === "}" && source[i - 1] !== "\\") {
      depth -= 1;
      if (depth === 0) return out;
    }
    out += char;
  }
  return "";
}

function removeCommandArguments(source, command) {
  let text = String(source || "");
  const marker = `\\${command}{`;
  while (text.includes(marker)) {
    const start = text.indexOf(marker);
    let depth = 1;
    let end = start + marker.length;
    while (end < text.length && depth > 0) {
      if (text[end] === "{" && text[end - 1] !== "\\") depth += 1;
      else if (text[end] === "}" && text[end - 1] !== "\\") depth -= 1;
      end += 1;
    }
    text = text.slice(0, start) + text.slice(end);
  }
  return text;
}

function authorFromSource(source) {
  const raw = commandArgument(source, "author");
  if (!raw) return "";
  return raw.split(/\\and\b/)
    .map((part) => removeCommandArguments(part, "thanks").split(/\\\\/)[0])
    .map((part) => part.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, "").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

function inlineText(inlines) {
  const out = [];
  for (const item of inlines || []) {
    if (!item || typeof item !== "object") continue;
    if (item.t === "Str") out.push(String(item.c || ""));
    else if (item.t === "Space" || item.t === "SoftBreak" || item.t === "LineBreak") out.push(" ");
    else if (item.t === "Code") out.push(String(item.c?.[1] || ""));
    else if (item.t === "Math") {
      const display = item.c?.[0]?.t === "DisplayMath";
      const latex = String(item.c?.[1] || "");
      out.push(display ? `\n$$${latex}$$\n` : `$${latex}$`);
    } else if (["Emph", "Strong", "Strikeout", "Superscript", "Subscript", "SmallCaps"].includes(item.t)) {
      out.push(inlineText(item.c || []));
    } else if (["Link", "Image"].includes(item.t)) {
      out.push(inlineText(item.c?.[1] || []));
    } else if (item.t === "Quoted") {
      out.push(inlineText(item.c?.[1] || []));
    } else if (item.t === "Cite") {
      const rendered = inlineText(item.c?.[1] || []);
      const ids = (item.c?.[0] || []).map((citation) => citation.citationId).filter(Boolean);
      out.push(rendered || (ids.length ? `[${ids.join("; ")}]` : ""));
    } else if (Array.isArray(item.c)) {
      out.push(inlineText(item.c));
    }
  }
  return cleanText(out.join("").replace(/[ \t]+/g, " "));
}

function blocksText(blocks) {
  const out = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object") return;
    if (["Plain", "Para", "Header"].includes(value.t)) {
      out.push(inlineText(value.t === "Header" ? value.c?.[2] : value.c));
      return;
    }
    if (value.t === "CodeBlock") {
      out.push(String(value.c?.[1] || ""));
      return;
    }
    if (value.t === "RawBlock") return;
    visit(value.c);
  };
  visit(blocks);
  return cleanText(out.filter(Boolean).join("\n"));
}

function hasRichInline(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasRichInline);
  if (typeof value !== "object") return false;
  if (["Math", "Image", "Note", "RawInline"].includes(value.t)) return true;
  return hasRichInline(value.c);
}

function blockKind(block) {
  if (!block || typeof block !== "object") return "rich";
  if (block.t === "Header") return "heading";
  if (block.t === "Table") return "table";
  if (block.t === "CodeBlock") return "code";
  if (hasRichInline(block)) return "rich";
  if (["BulletList", "OrderedList", "BlockQuote", "Div", "Figure"].includes(block.t)) return "rich";
  return "text";
}

function wrapPandocBlocks(document) {
  const wrapped = [];
  for (let i = 0; i < document.blocks.length; i += 1) {
    wrapped.push({ t: "RawBlock", c: ["html", `<!--RA_BLOCK_START:${i}-->`] });
    wrapped.push(document.blocks[i]);
    wrapped.push({ t: "RawBlock", c: ["html", `<!--RA_BLOCK_END:${i}-->`] });
  }
  return { ...document, blocks: wrapped };
}

function extractRenderedBlocks(html, count) {
  const rendered = [];
  for (let i = 0; i < count; i += 1) {
    const start = `<!--RA_BLOCK_START:${i}-->`;
    const end = `<!--RA_BLOCK_END:${i}-->`;
    const from = html.indexOf(start);
    const to = html.indexOf(end, from + start.length);
    rendered.push(from >= 0 && to >= 0 ? html.slice(from + start.length, to).trim() : "");
  }
  return rendered;
}

function normalizeMathGlyphs(html) {
  const bmpVariants = new Map([
    ...["ℬ", "ℰ", "ℱ", "ℋ", "ℐ", "ℒ", "ℳ", "ℛ", "ℯ", "ℊ", "ℴ"].map((char) => [char, "script"]),
    ...["ℌ", "ℑ", "ℜ", "ℨ"].map((char) => [char, "fraktur"]),
    ...["ℂ", "ℍ", "ℕ", "ℙ", "ℚ", "ℝ", "ℤ"].map((char) => [char, "double-struck"]),
  ]);
  const variantFor = (char) => {
    if (bmpVariants.has(char)) return bmpVariants.get(char);
    const code = char.codePointAt(0);
    const ranges = [
      [0x1D400, 0x1D433, "bold"], [0x1D434, 0x1D467, "italic"],
      [0x1D468, 0x1D49B, "bold-italic"], [0x1D49C, 0x1D4CF, "script"],
      [0x1D4D0, 0x1D503, "bold-script"], [0x1D504, 0x1D537, "fraktur"],
      [0x1D538, 0x1D56B, "double-struck"], [0x1D56C, 0x1D59F, "bold-fraktur"],
      [0x1D5A0, 0x1D5D3, "sans-serif"], [0x1D5D4, 0x1D607, "bold-sans-serif"],
      [0x1D608, 0x1D63B, "sans-serif-italic"], [0x1D63C, 0x1D66F, "sans-serif-bold-italic"],
      [0x1D670, 0x1D6A3, "monospace"], [0x1D6A8, 0x1D6E1, "bold"],
      [0x1D6E2, 0x1D71B, "italic"], [0x1D71C, 0x1D755, "bold-italic"],
      [0x1D756, 0x1D78F, "bold-sans-serif"], [0x1D790, 0x1D7C9, "sans-serif-bold-italic"],
      [0x1D7CE, 0x1D7D7, "bold"], [0x1D7D8, 0x1D7E1, "double-struck"],
      [0x1D7E2, 0x1D7EB, "sans-serif"], [0x1D7EC, 0x1D7F5, "bold-sans-serif"],
      [0x1D7F6, 0x1D7FF, "monospace"],
    ];
    return ranges.find(([from, to]) => code >= from && code <= to)?.[2] || "";
  };
  return String(html || "").replace(/<mi>([^<]+)<\/mi>/g, (whole, value) => {
    const chars = [...value];
    if (chars.length !== 1) return whole;
    const variant = variantFor(chars[0]);
    if (!variant) return whole;
    const normalized = chars[0].normalize("NFKC");
    return `<mi mathvariant="${variant}">${normalized}</mi>`;
  });
}

function sourceFigureMedia(source) {
  const figures = [];
  const figureRe = /\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g;
  let figure;
  while ((figure = figureRe.exec(String(source || "")))) {
    const refs = [];
    const imageRe = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;
    let image;
    while ((image = imageRe.exec(figure[1]))) refs.push(image[1].trim());
    figures.push(refs);
  }
  return figures;
}

function mediaTypeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".pdf") return "application/pdf";
  return "";
}

function resolveMediaFile(root, reference) {
  if (!root || !reference || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return "";
  const candidates = [reference, `${reference}.png`, `${reference}.jpg`, `${reference}.jpeg`, `${reference}.pdf`];
  const normalizedRoot = path.resolve(root);
  for (const candidate of candidates) {
    const file = path.resolve(normalizedRoot, candidate);
    if (file !== normalizedRoot && !file.startsWith(`${normalizedRoot}${path.sep}`)) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile() && mediaTypeOf(file)) return file;
  }
  return "";
}

function expandTexInputs(source, root, seen = new Set(), depth = 0) {
  if (!root || depth > 8) return String(source || "");
  const normalizedRoot = path.resolve(root);
  return String(source || "").replace(/\\(?:input|include)\{([^}]+)\}/g, (whole, reference) => {
    const withExt = path.extname(reference) ? reference : `${reference}.tex`;
    const file = path.resolve(normalizedRoot, withExt);
    if (file !== normalizedRoot && !file.startsWith(`${normalizedRoot}${path.sep}`)) return whole;
    if (seen.has(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return whole;
    seen.add(file);
    return expandTexInputs(fs.readFileSync(file, "utf8"), normalizedRoot, seen, depth + 1);
  });
}

function attachTexMedia(sections, source, sourceDir) {
  if (!sourceDir) return [];
  const figures = sourceFigureMedia(source);
  const assets = [];
  let figureIndex = 0;
  let assetIndex = 0;
  for (const section of sections) {
    for (const block of section.blocks) {
      if (!block || typeof block !== "object" || !/<figure\b/i.test(block.html || "")) continue;
      const references = figures[figureIndex++] || [];
      block.media = [];
      for (const reference of references) {
        const file = resolveMediaFile(sourceDir, reference);
        if (!file) continue;
        const mediaType = mediaTypeOf(file);
        const ext = path.extname(file).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(file).toLowerCase();
        const name = `figure-${++assetIndex}${ext}`;
        assets.push({ name, mediaType, data: fs.readFileSync(file) });
        block.media.push({ asset: name, mediaType, label: path.basename(reference) });
      }
      block.html = String(block.html || "").replace(/<(?:img|embed)\b[^>]*>/gi, "");
    }
  }
  return assets;
}

function bibliographyParagraphs(raw) {
  const paragraphs = String(raw || "").split(/\r?\n\s*\r?\n/)
    .map((text) => cleanText(text.replace(/\r?\n/g, " ")))
    .filter(Boolean);
  if (paragraphs.length && /^\d+$/.test(paragraphs[0])) paragraphs.shift();
  return paragraphs;
}

function parseTex(input, { fallbackTitle = "未命名论文", sourcePath = "" } = {}) {
  const command = pandocCommand();
  const absoluteSource = sourcePath ? path.resolve(sourcePath) : "";
  const cwd = absoluteSource ? path.dirname(absoluteSource) : undefined;
  const firstArgs = ["--from=latex", "--to=json"];
  let jsonRaw;
  let sourceText;
  if (absoluteSource) {
    sourceText = expandTexInputs(fs.readFileSync(absoluteSource, "utf8"), cwd, new Set([absoluteSource]));
    jsonRaw = runTool(command, firstArgs, { input: sourceText, cwd });
  } else {
    sourceText = Buffer.isBuffer(input) ? input.toString("utf8") : String(input || "");
    jsonRaw = runTool(command, firstArgs, { input: sourceText, cwd });
  }

  let document;
  try {
    document = JSON.parse(String(jsonRaw));
  } catch {
    throw new Error("Pandoc 没有生成可识别的论文结构");
  }
  const abstractBlocks = document.meta?.abstract?.t === "MetaBlocks" && Array.isArray(document.meta.abstract.c)
    ? document.meta.abstract.c
    : [];
  const blocks = [...abstractBlocks, ...(Array.isArray(document.blocks) ? document.blocks : [])];
  if (!blocks.length) throw new Error("TeX 内容为空或没有可识别的正文");

  const renderedRaw = runTool(command, ["--from=json", "--to=html5", "--mathml", "--wrap=none"], {
    input: JSON.stringify(wrapPandocBlocks({ ...document, blocks })),
    cwd,
  });
  const rendered = extractRenderedBlocks(String(renderedRaw), blocks.length);

  const sections = [];
  let current = { title: abstractBlocks.length ? "Abstract" : "正文", blocks: [] };
  const flush = () => {
    if (current.blocks.length) sections.push(current);
  };

  blocks.forEach((block, index) => {
    const kind = blockKind(block);
    let text = blocksText([block]);
    if (block.t === "Header") {
      const heading = inlineText(block.c?.[2] || []);
      if (Number(block.c?.[0]) <= 2 && current.blocks.length) {
        flush();
        current = { title: heading || `第${sections.length + 1}节`, blocks: [] };
      } else if (!current.blocks.length && heading) {
        current.title = heading;
      }
      text = heading;
    }
    if (!text) text = kind === "table" ? "[表格]" : kind === "rich" ? "[论文图示或公式]" : "";
    if (!text) return;
    const html = normalizeMathGlyphs(rendered[index]).replace(
      /<span class="citation"[^>]*data-cites="([^"]+)"[^>]*><\/span>/g,
      (_whole, ids) => `<span>[${ids.trim().split(/\s+/).join("; ")}]</span>`
    );
    if (kind === "text") current.blocks.push(text);
    else current.blocks.push({ kind, text, html });
  });
  flush();
  if (!sections.length) throw new Error("TeX 没有生成可阅读的章节");
  const assets = attachTexMedia(sections, sourceText, cwd);
  if (absoluteSource) {
    const bblPath = path.join(cwd, `${path.basename(absoluteSource, path.extname(absoluteSource))}.bbl`);
    if (fs.existsSync(bblPath) && fs.statSync(bblPath).isFile()) {
      const plain = runTool(command, ["--from=latex", "--to=plain", "--wrap=none"], {
        input: fs.readFileSync(bblPath, "utf8"),
        cwd,
      });
      const references = bibliographyParagraphs(plain);
      if (references.length) sections.push({ title: "References", blocks: references });
    }
  }

  return {
    metadata: {
      title: metaText(document.meta?.title) || fallbackTitle,
      author: authorFromSource(sourceText) || metaText(document.meta?.author),
    },
    sections,
    assets,
    cover: null,
    contentKind: "paper-tex",
  };
}

function parsePdfInfo(raw) {
  const info = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) info[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return info;
}

function pdfPageParagraphs(raw) {
  const paragraphs = [];
  let current = [];
  const flush = () => {
    const text = current.join(" ")
      .replace(/-\s+([a-z])/g, "$1")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (text) paragraphs.push(text);
    current = [];
  };
  for (const line of String(raw || "").replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) flush();
    else current.push(trimmed);
  }
  flush();
  return paragraphs;
}

function pdfItemsText(items) {
  const lines = [];
  let current = "";
  for (const item of items || []) {
    const value = String(item?.str || "");
    if (value) current += `${current && !/^\s/.test(value) ? " " : ""}${value}`;
    if (item?.hasEOL) {
      lines.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) lines.push(current.trim());
  return pdfPageParagraphs(lines.join("\n"));
}

async function parsePdf(input, { fallbackTitle = "未命名论文", sourcePath = "" } = {}) {
  const bytes = sourcePath ? fs.readFileSync(path.resolve(sourcePath)) : Buffer.from(input || []);
  if (!bytes.length) throw new Error("PDF 内容为空");
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (error) {
    throw new Error(`PDF.js 加载失败：${error.message}`);
  }
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const document = await loadingTask.promise;
  const metadata = await document.getMetadata().catch(() => ({ info: {} }));
  const info = metadata?.info || {};
  const sections = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const pdfPage = await document.getPage(page);
    const content = await pdfPage.getTextContent();
    const textBlocks = pdfItemsText(content.items);
    const label = `PDF 第 ${page} 页`;
    const blocks = [{ kind: "pdf-page", text: `[${label}原页]`, asset: "source.pdf", page }];
    blocks.push(...(textBlocks.length ? textBlocks : [`[${label}没有提取到文字，请查看原页]`]));
    sections.push({ title: label, blocks });
    pdfPage.cleanup();
  }
  await loadingTask.destroy();
  return {
    metadata: { title: String(info.Title || fallbackTitle), author: String(info.Author || "") },
    sections,
    assets: [{ name: "source.pdf", mediaType: "application/pdf", data: bytes }],
    cover: null,
    contentKind: "paper-pdf",
  };
}

module.exports = {
  parseTex,
  parsePdf,
  pdfPageParagraphs,
  parsePdfInfo,
  pdfItemsText,
  blocksText,
  normalizeMathGlyphs,
  bibliographyParagraphs,
};
