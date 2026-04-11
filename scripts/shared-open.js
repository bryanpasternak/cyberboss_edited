const { spawn } = require("child_process");
const {
  listenUrl,
  ensureSharedAppServer,
  resolveBoundThread,
} = require("./shared-common");

async function main() {
  const workspaceRoot = process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();
  await ensureSharedAppServer();

  const { threadId, workspaceRoot: resolvedWorkspaceRoot } = resolveBoundThread(workspaceRoot);

  // ==================== 修改部分开始 ====================
  // 这里强制指定你想要的模型（推荐用 google/gemini-2.0-flash-lite-001 或 qwen/qwen2.5-32b:free）
  const desiredModel = "deepseek/deepseek-v3.2";   // ←←← 你可以在这里改模型

  const args = [
    "resume",
    threadId,
    "--remote",
    listenUrl,
    "-C",
    resolvedWorkspaceRoot,
    "--model", desiredModel,        // 关键：强制传入模型
    ...process.argv.slice(2),
  ];
  // ==================== 修改部分结束 ====================

  const child = spawn(process.env.CYBERBOSS_CODEX_COMMAND || "codex", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});