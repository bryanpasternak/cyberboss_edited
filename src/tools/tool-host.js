class ProjectToolHost {
  constructor({ services, runtimeContextStore }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
  }

  listTools() {
    return PROJECT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    if (!spec) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    const resolvedContext = this.resolveContext(context);
    return await spec.handler({
      services: this.services,
      args: args && typeof args === "object" ? args : {},
      context: resolvedContext,
    });
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
    };
  }
}

function buildProjectToolGuide(topics = []) {
  const normalizedTopics = Array.from(new Set(
    (Array.isArray(topics) ? topics : [])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean)
  ));
  if (!normalizedTopics.length) {
    return "";
  }

  const lines = [
    "Cyberboss project tools are available for timeline, reminders, diary, screenshots, and WeChat file sending.",
    "Use project tools instead of shell commands or local CLI wrappers for these operations.",
  ];
  const mentioned = new Set();
  for (const topic of normalizedTopics) {
    for (const tool of PROJECT_TOOLS) {
      if (!tool.topics.includes(topic) || mentioned.has(tool.name)) {
        continue;
      }
      mentioned.add(tool.name);
      lines.push(`- ${tool.name}: ${tool.shortHint}`);
    }
  }
  return lines.join("\n");
}

const PROJECT_TOOLS = [
  {
    name: "cyberboss_diary_append",
    description: "Append a diary entry into Cyberboss local diary storage without using shell commands.",
    shortHint: "Append a diary entry with text or a text file.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        textFile: { type: "string" },
        title: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Diary appended to ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_reminder_create",
    description: "Create a reminder in Cyberboss without using shell commands.",
    shortHint: "Create a reminder with delay or absolute time.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      properties: {
        delay: { type: "string" },
        at: { type: "string" },
        text: { type: "string" },
        textFile: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.reminder.create(args, context);
      return {
        text: `Reminder queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_system_send",
    description: "Queue an internal Cyberboss system trigger for the current bound workspace and chat.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_write",
    description: "Write timeline events through timeline-for-agent without using shell commands.",
    shortHint: "Write timeline events from eventsJson or eventsFile.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string" },
        eventsJson: { type: "string" },
        eventsFile: { type: "string" },
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.write(args);
      return {
        text: "Timeline write completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_screenshot",
    description: "Queue a timeline screenshot to be captured and sent back to the current WeChat chat.",
    shortHint: "Queue a timeline screenshot with optional locale and extra args.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        outputFile: { type: "string" },
        locale: { type: "string" },
        args: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.timeline.queueScreenshot(args, context);
      return {
        text: `Timeline screenshot queued: ${result.id}`,
        data: result,
      };
    },
  },
];

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ProjectToolHost,
  buildProjectToolGuide,
};
