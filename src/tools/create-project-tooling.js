const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createTelegramChannelAdapter } = require("../adapters/channel/telegram");
const { createQqChannelAdapter } = require("../adapters/channel/qq");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { IdentityMapStore } = require("../core/identity-map-store");
const { LastActiveChannelStore } = require("../core/last-active-channel-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ChannelFileService } = require("../services/channel-file-service");
const { ChannelDeliveryTargetResolver } = require("../services/channel-delivery-target-resolver");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { StickerService } = require("../services/sticker-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { createDesireService } = require("../services/desire-service");
const { createChatMemoryRuntime } = require("../services/chat-memory");
const { createMementoServices } = require("../services/mementos");
const { createLifeCalendarServices } = require("../services/life-calendar");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");
const { WhereaboutsService } = require("whereabouts-mcp");

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const identityMapStore = options.identityMapStore || new IdentityMapStore({ filePath: config.identityMapFile });
  const channels = options.channels instanceof Map
    ? options.channels
    : createToolChannels(config, { identityMapStore, fallbackAdapter: options.channelAdapter });
  const channelAdapter = options.channelAdapter
    || channels.get("weixin")
    || channels.values().next().value
    || createWeixinChannelAdapter(config);
  if (!channels.size) {
    channels.set(channelAdapter.describe?.().id || "weixin", channelAdapter);
  }
  const lastActiveStore = options.lastActiveStore || new LastActiveChannelStore({
    filePath: config.lastActiveChannelFile,
  });
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const deliveryTargetResolver = options.deliveryTargetResolver || new ChannelDeliveryTargetResolver({
    config,
    sessionStore,
    channels,
    identityMapStore,
    lastActiveStore,
    defaultChannelId: config.defaultOutboundChannel,
  });
  const channelFile = new ChannelFileService({
    resolveTarget: (payload) => deliveryTargetResolver.resolve(payload),
    resolveChannel: (channelId) => channels.get(String(channelId || "").trim().toLowerCase()) || null,
  });
  const chatMemoryRuntime = createChatMemoryRuntime({ config });
  const mementos = createMementoServices(config);
  const lifeCalendar = createLifeCalendarServices({
    stateDir: config.stateDir,
    timezone: "Asia/Shanghai",
  });
  const services = {
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore }),
    system: new SystemMessageService({ config, sessionStore }),
    channelFile,
    chatMemory: chatMemoryRuntime.memory,
    promiseMemory: chatMemoryRuntime.promises,
    chatMemoryRuntime,
    desire: createDesireService(config),
    memento: mementos.memento,
    gift: mementos.gift,
    postcard: mementos.postcard,
    travelCard: mementos.travelCard,
    lifeCalendar,
    sticker: new StickerService({ config, channelAdapter, sessionStore, channelFileService: channelFile }),
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

function createToolChannels(config, { identityMapStore, fallbackAdapter = null } = {}) {
  const channels = new Map();
  const requested = Array.isArray(config.channels) && config.channels.length
    ? config.channels
    : [config.channel || "weixin"];
  for (const rawId of requested) {
    const channelId = String(rawId || "").trim().toLowerCase();
    if (!channelId || channels.has(channelId)) continue;
    if (channelId === "weixin") {
      channels.set(channelId, fallbackAdapter?.describe?.().id === "weixin"
        ? fallbackAdapter
        : createWeixinChannelAdapter(config));
    } else if (channelId === "telegram") {
      channels.set(channelId, fallbackAdapter?.describe?.().id === "telegram"
        ? fallbackAdapter
        : createTelegramChannelAdapter(config, { identityMapStore }));
    } else if (channelId === "qq") {
      channels.set(channelId, fallbackAdapter?.describe?.().id === "qq"
        ? fallbackAdapter
        : createQqChannelAdapter(config, { identityMapStore }));
    }
  }
  if (!channels.size && fallbackAdapter) {
    channels.set(fallbackAdapter.describe?.().id || "weixin", fallbackAdapter);
  }
  return channels;
}

module.exports = { createProjectTooling, createToolChannels };
