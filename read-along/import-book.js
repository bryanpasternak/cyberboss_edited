#!/usr/bin/env node
// 用法: node import-book.js <epub|txt|tex|pdf路径> [--id 自定义bookId]
const fs = require("fs");
const path = require("path");
const { parseEpub } = require("./lib/epub");
const { parseTxt } = require("./lib/txt");
const { parseTex, parsePdf } = require("./lib/paper");
const { importParsed } = require("./lib/import");

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args.find((a) => !a.startsWith("--"));
  if (!inputPath) {
    console.error("usage: node import-book.js <epub|txt|tex|pdf> [--id xxx]");
    process.exit(1);
  }
  const idFlag = args.indexOf("--id");
  const bookId = idFlag >= 0 && args[idFlag + 1] ? args[idFlag + 1] : undefined;

  const ext = path.extname(inputPath).toLowerCase();
  let parsed;
  if (ext === ".txt") {
    parsed = parseTxt(fs.readFileSync(inputPath), { fallbackTitle: path.basename(inputPath, ext) });
  } else if (ext === ".epub") {
    parsed = parseEpub(inputPath);
  } else if (ext === ".tex") {
    parsed = parseTex(null, { fallbackTitle: path.basename(inputPath, ext), sourcePath: inputPath });
  } else if (ext === ".pdf") {
    parsed = await parsePdf(null, { fallbackTitle: path.basename(inputPath, ext), sourcePath: inputPath });
  } else {
    throw new Error(`unsupported file type: ${ext || "(none)"}`);
  }

  const summary = importParsed(parsed, { bookId, sourceFile: path.basename(inputPath) });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
