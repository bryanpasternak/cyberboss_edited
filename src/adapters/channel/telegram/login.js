const readline = require("readline");
const { getMe } = require("./api");
const { saveTelegramAccount } = require("./account-store");

function promptToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Paste your Telegram bot token (from @BotFather): ", (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

async function runTelegramLoginFlow(config) {
  console.log("[cyberboss] Telegram bot registration");
  let token = String(config.telegramBotToken || "").trim();
  if (!token) {
    token = await promptToken();
  }
  if (!token) {
    throw new Error("Bot token is required.");
  }

  const baseUrl = config.telegramApiBaseUrl || "https://api.telegram.org";
  console.log("[cyberboss] verifying bot token via getMe...");
  const me = await getMe({ baseUrl, botToken: token, timeoutMs: 15_000 });
  const botId = Number(me?.id) || 0;
  const botUsername = typeof me?.username === "string" ? me.username : "";
  if (!botId) {
    throw new Error("getMe response did not include a bot id");
  }
  const accountId = botUsername || String(botId);
  const account = saveTelegramAccount(config, accountId, {
    botId,
    botUsername,
    botToken: token,
    apiBaseUrl: baseUrl,
  });
  console.log("\n✅ Telegram bot registered.");
  console.log(`accountId: ${account.accountId}`);
  console.log(`botId: ${account.botId}`);
  console.log(`botUsername: @${account.botUsername || "(unknown)"}`);
  console.log(`apiBaseUrl: ${account.apiBaseUrl}`);
  console.log("\nNext: in Telegram, message your bot and send /link <code> from WeChat to bind identities.");
}

module.exports = { runTelegramLoginFlow };
