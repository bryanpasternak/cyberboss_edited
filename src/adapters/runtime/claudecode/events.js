const {
  extractApprovalCommandTokens,
  extractApprovalFilePath,
  extractApprovalFilePaths,
  buildApprovalMatchTokens,
} = require("../shared/approval-command");

function mapClaudeCodeMessageToRuntimeEvent(message, raw) {
  const type = message?.type;
  switch (type) {
    case "turn.started":
      return {
        type: "runtime.turn.started",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
        },
      };
    case "reply.completed":
      return {
        type: "runtime.reply.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          itemId: `item-${message.turnId}`,
          text: message.text,
        },
      };
    case "turn.completed":
      return {
        type: "runtime.turn.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          text: typeof message.text === "string" ? message.text : "",
        },
      };
    case "approval.requested":
      return {
        type: "runtime.approval.requested",
        payload: {
          threadId: message.sessionId,
          requestId: message.requestId,
          reason: `Tool: ${message.toolName || ""}`,
          command: formatToolCommand(message.toolName, message.input),
          filePath: extractApprovalFilePath(message.input, { preferredKeys: ["file_path", "filePath", "path"] }),
          filePaths: extractApprovalFilePaths(message.input, { preferredKeys: ["file_path", "filePath", "path"] }),
          commandTokens: buildApprovalMatchTokens({
            toolName: message.toolName,
            commandTokens: extractApprovalCommandTokens(message.input, { preferredKeys: ["prefix_rule"] }),
            input: message.input,
            options: { preferredKeys: ["prefix_rule"] },
          }),
        },
      };
    case "process.error":
    case "process.close":
      return {
        type: "runtime.turn.failed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          text: message.error || "❌ Runtime process exited unexpectedly",
        },
      };
    case "session.id":
      return null;
    default:
      return null;
  }
}

function formatToolCommand(toolName, input) {
  const name = typeof toolName === "string" ? toolName : "";
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return name;
  }
  const keys = Object.keys(input);
  if (keys.length === 0) {
    return name;
  }
  const formatted = keys
    .map((key) => `${key}: ${JSON.stringify(input[key])}`)
    .join("\n");
  const full = `${name}\n${formatted}`;
  return truncateCommand(full);
}

function truncateCommand(text, maxLines = 6, maxLineLength = 100) {
  const lines = String(text || "").split("\n");
  const truncated = lines.slice(0, maxLines).map((line) => {
    if (line.length <= maxLineLength) return line;
    return line.slice(0, maxLineLength) + " …";
  });
  const result = truncated.join("\n");
  if (lines.length > maxLines) {
    return result + "\n…";
  }
  return result;
}

module.exports = { mapClaudeCodeMessageToRuntimeEvent };
