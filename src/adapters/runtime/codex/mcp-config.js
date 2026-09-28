const fs = require("fs");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");

function resolveCodexProjectToolMcpServerConfig({ cyberbossHome = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
    approvalTools: listProjectToolNames(),
  };
}

function resolveStoneMemoryMcpServerConfig({ cyberbossHome = "", threadId = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const stoneMemoryRoot = normalizeNonEmptyString(process.env.CYBERBOSS_STMEM_ROOT)
    || path.join(home, "stmem_core");
  const scriptPath = path.join(stoneMemoryRoot, "mcp-server.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const enabledTools = [
    "stmem_memory_status",
    "stmem_memory_search",
    "stmem_memory_deep_search",
    "stmem_dream_latest",
    "stmem_dream_status",
    "stmem_dream_get",
    "stmem_notebook_status",
    "stmem_notebook_delegate",
    "stmem_memory_rebuild_preview",
    "stmem_memory_rebuild",
  ];
  const approvalTools = [
    "stmem_memory_status",
    "stmem_memory_search",
    "stmem_dream_latest",
    "stmem_dream_status",
    "stmem_dream_get",
    "stmem_notebook_status",
    "stmem_notebook_delegate",
    "stmem_memory_rebuild_preview",
  ];
  const defaultThreadId = normalizeNonEmptyString(threadId)
    || normalizeNonEmptyString(process.env.CYBERBOSS_STMEM_THREAD_ID);
  return {
    name: "stone_memory",
    command: process.execPath,
    args: [scriptPath],
    cwd: stoneMemoryRoot,
    env: {
      STMEM_SKIP_PENDING_REBUILDS: "1",
      ...(defaultThreadId ? { STMEM_THREAD_ID: defaultThreadId } : {}),
    },
    enabledTools,
    approvalTools,
    defaultApprovalMode: "prompt",
    toolTimeoutSec: 150,
  };
}

function resolveCodexMcpServerConfigs(options = {}) {
  return [
    resolveCodexProjectToolMcpServerConfig(options),
    resolveStoneMemoryMcpServerConfig(options),
  ].filter(Boolean);
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  const configs = Array.isArray(mcpServerConfig) ? mcpServerConfig : [mcpServerConfig];
  return configs.flatMap(buildSingleCodexMcpConfigArgs);
}

function buildSingleCodexMcpConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") return [];
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "cyberboss_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = normalizeStringList(mcpServerConfig.args);
  if (!command) return [];

  const configArgs = [];
  pushConfigValue(configArgs, `mcp_servers.${name}.command`, quoteTomlString(command));
  pushConfigValue(configArgs, `mcp_servers.${name}.args`, formatTomlArray(args));

  const cwd = normalizeNonEmptyString(mcpServerConfig.cwd);
  if (cwd) pushConfigValue(configArgs, `mcp_servers.${name}.cwd`, quoteTomlString(cwd));

  for (const [envName, envValue] of Object.entries(mcpServerConfig.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) continue;
    pushConfigValue(
      configArgs,
      `mcp_servers.${name}.env.${envName}`,
      quoteTomlString(envValue),
    );
  }

  const enabledTools = normalizeStringList(mcpServerConfig.enabledTools);
  if (enabledTools.length) {
    pushConfigValue(configArgs, `mcp_servers.${name}.enabled_tools`, formatTomlArray(enabledTools));
  }

  const defaultApprovalMode = normalizeNonEmptyString(mcpServerConfig.defaultApprovalMode);
  if (defaultApprovalMode) {
    pushConfigValue(
      configArgs,
      `mcp_servers.${name}.default_tools_approval_mode`,
      quoteTomlString(defaultApprovalMode),
    );
  }

  const toolTimeoutSec = Number(mcpServerConfig.toolTimeoutSec);
  if (Number.isFinite(toolTimeoutSec) && toolTimeoutSec > 0) {
    pushConfigValue(configArgs, `mcp_servers.${name}.tool_timeout_sec`, String(toolTimeoutSec));
  }

  const approvalTools = Array.isArray(mcpServerConfig.approvalTools)
    ? normalizeStringList(mcpServerConfig.approvalTools)
    : (name === "cyberboss_tools" ? listProjectToolNames() : []);
  for (const toolName of approvalTools) {
    pushConfigValue(
      configArgs,
      `mcp_servers.${name}.tools.${toolName}.approval_mode`,
      quoteTomlString("auto"),
    );
  }
  return configArgs;
}

function pushConfigValue(target, key, value) {
  target.push("-c", `${key}=${value}`);
}

function normalizeStringList(values) {
  return Array.isArray(values)
    ? values.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  resolveCodexMcpServerConfigs,
  resolveCodexProjectToolMcpServerConfig,
  resolveStoneMemoryMcpServerConfig,
};
