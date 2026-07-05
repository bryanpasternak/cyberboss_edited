const { ChatCaptureService } = require("./chat-capture-service");
const { ChatMemoryChunkerService } = require("./chat-memory-chunker-service");
const { ChatMemoryScheduler } = require("./chat-memory-scheduler");
const { ChatMemoryService } = require("./chat-memory-service");
const { ChatMemorySettingsStore } = require("./chat-memory-settings-store");
const { DeepSeekClient } = require("./deepseek-client");
const { DeepSeekRelevanceFilter } = require("./deepseek-relevance-filter");
const { DeepSeekSummarizer } = require("./deepseek-summarizer-service");
const { EmbeddingClient } = require("./embedding-client");
const { PromiseClassifier } = require("./promise-classifier");
const { PromiseService } = require("./promise-service");

function createChatMemoryRuntime({ config = {}, systemMessageQueue = null } = {}) {
  const injectLimit = Number(config.chatMemoryInjectLimit);
  const settings = new ChatMemorySettingsStore({
    filePath: config.chatMemoryConfigFile,
    defaults: {
      injectEnabled: Boolean(config.chatMemoryInjectEnabled),
      injectLimit: Number.isFinite(injectLimit) ? Math.max(0, injectLimit) : 6,
    },
  });

  const embeddings = new EmbeddingClient({ config });

  // 旧 chunker（始终创建，作为 fallback）
  const chunker = new ChatMemoryChunkerService({ config, embeddings });

  // DeepSeek 组件（按需创建）
  const deepseekClient = config.chatMemoryDeepSeekEnabled
    ? new DeepSeekClient({ config })
    : null;

  const summarizer = deepseekClient?.isReady?.()
    ? new DeepSeekSummarizer({ config, deepseekClient, embeddings })
    : null;

  const relevanceFilter = deepseekClient?.isReady?.()
    ? new DeepSeekRelevanceFilter({ config, deepseekClient })
    : null;

  // 调度器：同时支持 cron（DeepSeek）和 idle（旧 chunker）
  const scheduler = new ChatMemoryScheduler({ config, chunker, summarizer });

  // 采集服务（不变）
  const capture = new ChatCaptureService({ config, scheduler });

  // 检索服务：接入 DeepSeek 重排
  const memory = new ChatMemoryService({ config, embeddings, settings, relevanceFilter });

  // Promise 系统（不变）
  const promiseClassifier = new PromiseClassifier({ config });
  const promises = new PromiseService({ config, systemMessageQueue, classifier: promiseClassifier });

  return {
    capture,
    scheduler,
    chunker,
    summarizer,
    relevanceFilter,
    memory,
    promises,
    promiseClassifier,
    deepseekClient,
    settings,
    config,
    enabled: Boolean(config.chatMemoryEnabled),
  };
}

module.exports = {
  createChatMemoryRuntime,
  ChatCaptureService,
  ChatMemoryChunkerService,
  ChatMemoryScheduler,
  ChatMemoryService,
  ChatMemorySettingsStore,
  DeepSeekClient,
  DeepSeekRelevanceFilter,
  DeepSeekSummarizer,
  EmbeddingClient,
  PromiseClassifier,
  PromiseService,
};
