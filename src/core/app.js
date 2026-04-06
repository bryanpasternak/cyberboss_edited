const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createTimelineIntegration } = require("../integrations/timeline");

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.runtimeAdapter = createCodexRuntimeAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    try {
      const account = this.channelAdapter.resolveAccount();
      const runtimeState = await this.runtimeAdapter.initialize();
      const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
      const syncBuffer = this.channelAdapter.loadSyncBuffer();

      console.log("[cyberboss] bootstrap ok");
      console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
      console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
      console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
      console.log(`[cyberboss] account=${account.accountId}`);
      console.log(`[cyberboss] baseUrl=${account.baseUrl}`);
      console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
      console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
      console.log(`[cyberboss] codexEndpoint=${runtimeState.endpoint}`);
      console.log(`[cyberboss] codexModels=${runtimeState.models.length}`);
      console.log("[cyberboss] 底层初始化完成，下一步开始接最小消息链路。");
    } finally {
      await this.runtimeAdapter.close();
    }
  }
}

module.exports = { CyberbossApp };
