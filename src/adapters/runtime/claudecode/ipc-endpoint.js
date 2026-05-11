const crypto = require("crypto");
const os = require("os");
const path = require("path");

function resolveClaudeIpcEndpoint(stateDir = "") {
  const resolvedStateDir = path.resolve(stateDir || path.join(os.homedir(), ".cyberboss"));
  const tokenFile = path.join(resolvedStateDir, "claudecode-runtime.token");
  if (process.platform === "win32") {
    const stableId = crypto
      .createHash("sha256")
      .update(resolvedStateDir.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    const pipeName = `cyberboss-claudecode-runtime-${stableId}`;
    return {
      kind: "named-pipe",
      path: `\\\\?\\pipe\\${pipeName}`,
      displayPath: `\\\\.\\pipe\\${pipeName}`,
      tokenFile,
      stateDir: resolvedStateDir,
    };
  }
  const socketPath = path.join(resolvedStateDir, "claudecode-runtime.sock");
  return {
    kind: "socket",
    path: socketPath,
    displayPath: socketPath,
    tokenFile,
    stateDir: resolvedStateDir,
  };
}

module.exports = { resolveClaudeIpcEndpoint };
