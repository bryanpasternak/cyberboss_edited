const fs = require("fs");
const path = require("path");

/**
 * Build anchor context text for injection during a new Claude Code thread opening turn.
 * Reads all files from the anchor directory and a custom startup prompt file.
 *
 * @param {object} options
 * @param {string} options.anchorDir - path to the anchor directory
 * @param {string} options.startupPromptFile - path to the custom startup prompt file
 * @returns {string} formatted context text, or "" if nothing to inject
 */
function buildAnchorContext({ anchorDir = "", startupPromptFile = "" } = {}) {
  const blocks = [];

  // 1. Read all files from the anchor directory
  const normalizedAnchorDir = normalizeText(anchorDir);
  if (normalizedAnchorDir) {
    try {
      const entries = fs.readdirSync(normalizedAnchorDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();

      for (const fileName of files) {
        // Skip the startup prompt and midnight trigger files — they're handled separately
        if (fileName === "startup_prompt.txt" || fileName === "midnight_trigger.txt") {
          continue;
        }
        const filePath = path.join(normalizedAnchorDir, fileName);
        try {
          const content = fs.readFileSync(filePath, "utf8").trim();
          if (content) {
            blocks.push(`--- ${fileName} ---\n${content}`);
          }
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // anchor dir doesn't exist or can't be read — skip silently
    }
  }

  // 2. Read the custom startup prompt
  const normalizedPromptFile = normalizeText(startupPromptFile);
  if (normalizedPromptFile) {
    try {
      const promptContent = fs.readFileSync(normalizedPromptFile, "utf8").trim();
      if (promptContent && !promptContent.startsWith("（在这里写")) {
        blocks.push(promptContent);
      }
    } catch {
      // file doesn't exist yet — skip silently
    }
  }

  if (!blocks.length) {
    return "";
  }

  return [
    "",
    "--- [Anchor Context — injected on new thread] ---",
    ...blocks,
    "--- [End Anchor Context] ---",
  ].join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { buildAnchorContext };
