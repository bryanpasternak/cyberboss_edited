---
name: windows-codex-ops
description: Diagnose and handle Windows-specific Codex development friction in the Cyberboss repository. Use for PowerShell quoting or encoding failures, hidden console windows, child-process spawning, sandbox or patch permission errors, batch-wrapper argument loss, and other behavior that may depend on the local Windows environment.
---

# Windows Codex Ops

Treat this as local operational memory, not universal Windows truth.

## Workflow

1. Inspect the current environment before applying a remembered fix: relevant file contents and diffs, command resolution, shell, encoding, permissions, and process-launch path.
2. Preserve unrelated working-tree changes. Narrow every edit to the smallest verified target.
3. Reproduce or inspect the actual failure before choosing a workaround.
4. Read [references/lessons.md](references/lessons.md) only when the problem involves Windows process spawning, patching, PowerShell encoding, batch wrappers, or sandbox permissions.
5. Prefer native PowerShell end to end for Windows file operations. Do not pass filesystem targets between shells for destructive operations.
6. After changing code or configuration, inspect the diff, run the narrowest syntax or behavior check available, and state what requires a service restart.
7. Add a lesson only after it was observed in this repository. Record the date, symptom, confirmed cause, workaround, verification, and scope limits.

## Guardrails

- Distinguish confirmed facts from hypotheses and machine-specific observations.
- Do not assume a prior workaround still applies after Codex, PowerShell, Node.js, or sandbox configuration changes.
- Do not weaken security controls globally to avoid a scoped approval.
- Do not overwrite user changes or use destructive Git recovery commands.
- If a command fails because of sandboxing and it is necessary, retry through the normal approval path instead of inventing a bypass.
