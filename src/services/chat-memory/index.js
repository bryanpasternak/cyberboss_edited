const { ChatCaptureService } = require("./chat-capture-service");
const { ChatMemoryChunkerService } = require("./chat-memory-chunker-service");
const { ChatMemoryScheduler } = require("./chat-memory-scheduler");
const { ChatMemoryService } = require("./chat-memory-service");
const { ChatMemorySettingsStore } = require("./chat-memory-settings-store");
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
  const chunker = new ChatMemoryChunkerService({ config, embeddings });
  const scheduler = new ChatMemoryScheduler({ config, chunker });
  const capture = new ChatCaptureService({ config, scheduler });
  const memory = new ChatMemoryService({ config, embeddings, settings });
  const promiseClassifier = new PromiseClassifier({ config });
  const promises = new PromiseService({ config, systemMessageQueue, classifier: promiseClassifier });
  return {
    capture,
    scheduler,
    chunker,
    memory,
    promises,
    promiseClassifier,
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
  EmbeddingClient,
  PromiseClassifier,
  PromiseService,
};
