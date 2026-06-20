#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      console.log(`[env] loaded ${envPath}`);
      return envPath;
    }
  }
  dotenv.config();
  console.log("[env] no .env file found, using ambient process env");
  return "";
}

loadEnv();

const { readConfig } = require(path.join(__dirname, "..", "src", "core", "config.js"));
const { PromiseClassifier } = require(path.join(__dirname, "..", "src", "services", "chat-memory", "promise-classifier.js"));

const SAMPLES = [
  { text: "我明天帮你带咖啡。", expect: true },
  { text: "今晚十点提醒我喝水。", expect: true },
  { text: "我先不动你，但记你账上。", expect: true },
  { text: "我明天还有点事。", expect: false },
  { text: "如果明天下雨我们就不去了。", expect: false },
  { text: "你先睡吧，我再看看代码。", expect: false },
];

async function main() {
  const cliText = process.argv.slice(2).join(" ").trim();
  const samples = cliText ? [{ text: cliText, expect: null }] : SAMPLES;

  const config = readConfig();
  config.promiseClassifierVerbose = true;
  config.promiseClassifierEnabled = true;

  const classifier = new PromiseClassifier({ config });

  console.log("=== Promise Classifier Diagnostic ===");
  console.log("provider :", classifier.provider);
  console.log("baseUrl  :", classifier.baseUrl || "(empty)");
  console.log("model    :", classifier.model || "(empty)");
  console.log("apiKey   :", classifier.apiKey ? `set (len=${classifier.apiKey.length})` : "(empty)");
  console.log("timeoutMs:", classifier.timeoutMs);
  console.log("proxy    :", classifier.proxyUrl || "(none — Node 默认直连，不会走系统代理)");
  console.log("dispatcher:", classifier.dispatcher ? "ProxyAgent active" : "default (direct)");
  console.log("isReady  :", classifier.isReady());
  console.log("");

  if (!classifier.isReady()) {
    console.error("Classifier 没准备好，先检查上面这几个字段对应的环境变量：");
    console.error("  CYBERBOSS_PROMISE_CLASSIFIER_ENABLED=1");
    console.error("  CYBERBOSS_PROMISE_CLASSIFIER_BASE_URL=<provider OpenAI compatible endpoint>");
    console.error("  CYBERBOSS_PROMISE_CLASSIFIER_API_KEY=<key>");
    console.error("  CYBERBOSS_PROMISE_CLASSIFIER_MODEL=<model id>");
    process.exit(2);
  }

  let passed = 0;
  let failed = 0;
  let nullCount = 0;
  for (const sample of samples) {
    process.stdout.write(`> ${sample.text}\n`);
    const verdict = await classifier.classify({ text: sample.text, promisor: "assistant" });
    if (verdict === null) {
      nullCount += 1;
      console.log("  verdict: null (failure / parse error)\n");
      continue;
    }
    const ok = sample.expect === null ? true : verdict.isPromise === sample.expect;
    if (ok) passed += 1; else failed += 1;
    console.log(`  -> is_promise=${verdict.isPromise} conf=${verdict.confidence} reason=${verdict.reason}${sample.expect === null ? "" : ` [expected=${sample.expect} ${ok ? "OK" : "MISMATCH"}]`}\n`);
  }

  console.log("=== Summary ===");
  console.log(`samples=${samples.length} passed=${passed} mismatch=${failed} null=${nullCount}`);
  if (nullCount === samples.length) {
    console.error("全部返回 null —— 多半是 API 没通；上面 verbose 日志会告诉你 HTTP 状态或异常原因。");
    process.exit(3);
  }
}

main().catch((error) => {
  console.error("FATAL:", error);
  process.exit(1);
});
