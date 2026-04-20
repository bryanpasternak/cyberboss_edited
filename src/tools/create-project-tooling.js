const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ChannelFileService } = require("../services/channel-file-service");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createWeixinChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const services = {
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore }),
    system: new SystemMessageService({ config, sessionStore }),
    channelFile: new ChannelFileService({ config, channelAdapter, sessionStore }),
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
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

module.exports = { createProjectTooling };
