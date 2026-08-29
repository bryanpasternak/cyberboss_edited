# Verified local lessons

These observations come from `C:\Users\19670\cyberboss`. Re-check them before reuse on another machine or after environment upgrades.

## 2026-07-21 — Background Node processes opened visible console windows

- Symptom: starting a Cyberboss background service could create a visible black console window.
- Confirmed local fix: add `windowsHide: true` to the relevant Node.js `spawn(...)` options in `scripts/shared-common.js`.
- Verification performed: inspect the focused diff and run the JavaScript syntax check.
- Activation: restart the shared/background service so new child processes use the changed options.
- Scope limit: this hides processes launched through that Cyberboss helper. A window created by Codex's own command-execution layer has a different launch path and needs separate diagnosis.

## 2026-07-21 — Patch write required scoped authorization

- Symptom: ordinary read/diagnostic commands worked, while the dedicated patch path was denied under the active multi-root Windows sandbox configuration.
- Confirmed local handling: resolve the exact target and diff first, then request scoped authorization for the patch operation.
- Scope limit: permission behavior is configuration-dependent. Test current write access instead of assuming all patches require authorization.

## 2026-07-21 — PowerShell pipeline changed patch text encoding

- Symptom: patch content passed through a PowerShell pipeline was rejected by a patch executor expecting UTF-8.
- Confirmed local cause: the pipeline encoded the text as UTF-16.
- Confirmed local handling: avoid that pipeline for patch payloads; use the dedicated patch tool or an invocation that preserves UTF-8.
- Scope limit: PowerShell version, output cmdlet, and external program affect encoding. Inspect the actual byte path before generalizing.

## 2026-07-21 — Batch wrapper damaged multiline patch arguments

- Symptom: passing a multiline patch through a `.bat` wrapper corrupted or split the argument.
- Confirmed local handling: bypass the batch wrapper and invoke the underlying official patch executable directly.
- Scope limit: this was observed for one wrapper and multiline payload shape. It does not imply every batch wrapper loses multiline arguments.

## Lesson template

When a new issue is verified, append:

- Date and short symptom
- Exact local environment or launch path
- Evidence and confirmed cause
- Smallest successful workaround or fix
- Verification performed
- Restart or activation requirement
- Scope limits and remaining uncertainty
