const fs = require("fs");
const path = require("path");
const readline = require("readline");

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function appendJsonLine(filePath, value) {
  ensureParentDirectory(filePath);
  await fs.promises.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJsonLines(filePath) {
  const records = [];
  try {
    const input = fs.createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        continue;
      }
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        records.push(null);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  return records.filter(Boolean);
}

function readJsonFile(filePath, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureParentDirectory(filePath);
  const dirPath = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const tempPath = path.join(
    dirPath,
    `.${baseName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    try {
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      if (!isReplaceableRenameError(error)) {
        throw error;
      }
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
      fs.renameSync(tempPath, filePath);
    }
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function isReplaceableRenameError(error) {
  return ["EEXIST", "EPERM", "EACCES"].includes(error?.code);
}

function listFilesSorted(dirPath, filter = () => true) {
  try {
    return fs.readdirSync(dirPath)
      .filter(filter)
      .map((name) => path.join(dirPath, name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

module.exports = {
  appendJsonLine,
  ensureParentDirectory,
  listFilesSorted,
  readJsonFile,
  readJsonLines,
  writeJsonFile,
};
