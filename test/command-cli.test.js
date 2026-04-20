const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildProjectToolGuide } = require("../src/tools/tool-host");
const { resolveBodyInput } = require("../src/services/text-input");
const { prepareTimelineInvocation } = require("../src/integrations/timeline");

function createTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-command-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("project tool guide tells the model to use project tools instead of shell commands", () => {
  const guide = buildProjectToolGuide(["reminder"]);
  assert.match(guide, /project tools/i);
  assert.match(guide, /cyberboss_reminder_create/);
  assert.doesNotMatch(guide, /npm --prefix/);
});

test("project tool guide scopes timeline hints to timeline tools", () => {
  const guide = buildProjectToolGuide(["timeline"]);
  assert.match(guide, /cyberboss_timeline_write/);
  assert.match(guide, /cyberboss_timeline_screenshot/);
  assert.doesNotMatch(guide, /cyberboss_reminder_create/);
});

test("reminder body can be loaded from --text-file", async () => {
  const filePath = createTempFile("reminder.txt", "  remember me  \n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "remember me");
});

test("diary body can be loaded from --text-file", async () => {
  const filePath = createTempFile("diary.md", "\nline one\nline two\n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "line one\nline two");
});

test("timeline invocation translates --locale and --events-file", () => {
  const filePath = createTempFile("events.json", "[{\"title\":\"ship it\"}]");
  const prepared = prepareTimelineInvocation("write", [
    "--date", "2026-04-11",
    "--locale", "en",
    "--events-file", filePath,
  ]);

  assert.deepEqual(prepared.extraEnv, { TIMELINE_FOR_AGENT_LOCALE: "en" });
  assert.deepEqual(prepared.args, [
    "--date", "2026-04-11",
    "--json", "[{\"title\":\"ship it\"}]",
  ]);
});

test("timeline invocation rejects mixed json sources", () => {
  assert.throws(() => {
    prepareTimelineInvocation("write", ["--json", "[]", "--events-json", "[]"]);
  }, /Use only one of --json, --events-json, or --events-file/);
});
