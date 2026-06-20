const COMMAND_GROUPS = [
  {
    id: "lifecycle",
    label: "Lifecycle & Diagnostics",
    actions: [
      {
        action: "app.login",
        summary: "Start WeChat QR login and save the account",
        terminal: ["login"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.accounts",
        summary: "List locally saved accounts",
        terminal: ["accounts"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.start",
        summary: "Start the current channel/runtime main loop",
        terminal: ["start"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.shared_start",
        summary: "Start the shared app-server and shared WeChat bridge",
        terminal: ["shared start"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.shared_open",
        summary: "Attach to the shared thread currently bound in WeChat",
        terminal: ["shared open"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.shared_status",
        summary: "Show the shared app-server and bridge status",
        terminal: ["shared status"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.doctor",
        summary: "Print current config, boundaries, and thread state",
        terminal: ["doctor"],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "system.send",
        summary: "Write an invisible trigger message into the internal system queue",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "system.checkin_poller",
        summary: "Emit proactive check-in triggers at random intervals",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "desire.panel",
        summary: "Start the local desire observation panel",
        terminal: ["desire"],
        weixin: [],
        telegram: [],
        status: "active",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace & Thread",
    actions: [
      {
        action: "workspace.bind",
        summary: "Bind the current chat to a workspace directory",
        terminal: [],
        weixin: ["/bind"],
        telegram: ["/bind"],
        status: "active",
      },
      {
        action: "workspace.status",
        summary: "Show the current workspace, thread, model, and context usage",
        terminal: [],
        weixin: ["/status"],
        telegram: ["/status"],
        status: "active",
      },
      {
        action: "thread.new",
        summary: "Switch to a fresh thread draft and prime it with prior recap and memories",
        terminal: [],
        weixin: ["/new"],
        telegram: ["/new"],
        status: "active",
      },
      {
        action: "thread.reread",
        summary: "Make the current thread reread the latest instructions",
        terminal: [],
        weixin: ["/reread"],
        telegram: ["/reread"],
        status: "active",
      },
      {
        action: "thread.compact",
        summary: "Compact the current thread context",
        terminal: [],
        weixin: ["/compact"],
        telegram: ["/compact"],
        status: "active",
      },
      {
        action: "thread.switch",
        summary: "Switch to a specific thread",
        terminal: [],
        weixin: ["/switch <threadId>"],
        telegram: ["/switch <threadId>"],
        status: "active",
      },
      {
        action: "thread.stop",
        summary: "Stop the current run inside the thread",
        terminal: [],
        weixin: ["/stop"],
        telegram: ["/stop"],
        status: "active",
      },
      {
        action: "system.checkin_range",
        summary: "Reset the proactive check-in range in minutes",
        terminal: [],
        weixin: ["/checkin <min>-<max>"],
        telegram: ["/checkin <min>-<max>"],
        status: "active",
      },
      {
        action: "desire.control",
        summary: "Inspect or control the local desire system",
        terminal: [],
        weixin: ["/desire", "/desire on", "/desire off"],
        telegram: ["/desire", "/desire on", "/desire off"],
        status: "active",
      },
      {
        action: "channel.chunk_min",
        summary: "Adjust the minimum short-chunk merge size for replies",
        terminal: [],
        weixin: ["/chunk <number>"],
        telegram: ["/chunk <number>"],
        status: "active",
      },
      {
        action: "memory.recall",
        summary: "Control automatic memory recall and the number of retrieved memories",
        terminal: [],
        weixin: ["/recall", "/recall on", "/recall off", "/recall <number>"],
        telegram: ["/recall", "/recall on", "/recall off", "/recall <number>"],
        status: "active",
      },
    ],
  },
  {
    id: "approval",
    label: "Approvals & Control",
    actions: [
      {
        action: "approval.accept_once",
        summary: "Allow the current approval request once",
        terminal: [],
        weixin: ["/yes"],
        telegram: ["/yes"],
        status: "active",
      },
      {
        action: "approval.accept_workspace",
        summary: "Keep allowing matching command prefixes in the current workspace",
        terminal: [],
        weixin: ["/always"],
        telegram: ["/always"],
        status: "active",
      },
      {
        action: "approval.reject_once",
        summary: "Deny the current approval request",
        terminal: [],
        weixin: ["/no"],
        telegram: ["/no"],
        status: "active",
      },
    ],
  },
  {
    id: "identity",
    label: "Identity & Cross-channel",
    actions: [
      {
        action: "identity.link_issue",
        summary: "Issue a one-time code so another channel can bind to this identity",
        terminal: [],
        weixin: ["/link"],
        telegram: ["/link"],
        status: "active",
      },
      {
        action: "identity.link_redeem",
        summary: "Redeem a code from another channel and bind this chat to that identity",
        terminal: [],
        weixin: ["/link <code>"],
        telegram: ["/link <code>"],
        status: "active",
      },
      {
        action: "identity.unlink",
        summary: "Remove this chat's identity binding on the current channel",
        terminal: [],
        weixin: ["/unlink"],
        telegram: ["/unlink"],
        status: "active",
      },
    ],
  },
  {
    id: "capabilities",
    label: "Capabilities",
    actions: [
      {
        action: "model.inspect",
        summary: "Inspect the current model",
        terminal: [],
        weixin: ["/model"],
        telegram: ["/model"],
        status: "active",
      },
      {
        action: "model.select",
        summary: "Switch to a specific model",
        terminal: [],
        weixin: ["/model <id>"],
        telegram: ["/model <id>"],
        status: "active",
      },
      {
        action: "channel.send_file",
        summary: "Send a local file back to the current chat as an attachment",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "timeline.write",
        summary: "Write the current context into timeline",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "timeline.build",
        summary: "Build the static timeline site",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "timeline.serve",
        summary: "Start the static timeline site server",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "timeline.dev",
        summary: "Start the hot-reload timeline dev server",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "timeline.screenshot",
        summary: "Capture a timeline screenshot",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "reminder.create",
        summary: "Create a reminder and hand it to the scheduler",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "diary.append",
        summary: "Append a diary entry",
        terminal: [],
        weixin: [],
        telegram: [],
        status: "active",
      },
      {
        action: "app.star",
        summary: "Star the project on GitHub",
        terminal: [],
        weixin: ["/star"],
        telegram: ["/star"],
        status: "active",
      },
      {
        action: "app.help",
        summary: "Show currently available commands for this channel",
        terminal: ["help"],
        weixin: ["/help"],
        telegram: ["/help"],
        status: "active",
      },
    ],
  },
];

function listCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    actions: group.actions.map((action) => ({ ...action })),
  }));
}

function buildTerminalHelpText() {
  const lines = [
    "Usage: cyberboss <command>",
    "",
    "Current terminal commands:",
    "  cyberboss start                   start all configured channels and the runtime loop",
    "  cyberboss login                   start WeChat QR login (default channel)",
    "  cyberboss login --channel telegram   register a Telegram bot token",
    "  cyberboss accounts                list locally saved accounts",
    "  cyberboss doctor                  print current config and thread state",
    "  cyberboss desire                  start the local desire observation panel",
    "  npm run shared:start              start the shared app-server and WeChat bridge",
    "  npm run shared:open               attach to the shared thread currently bound in WeChat",
    "  npm run shared:status             show shared bridge status",
  ];

  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => action.status === "active" && action.terminal.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push(`- ${group.label}`);
    for (const action of activeActions) {
      lines.push(`  ${formatTerminalExamples(action)}  ${action.summary}`);
    }
  }

  lines.push("");
  lines.push("Cyberboss capability operations are exposed to models as project tools, not terminal subcommands.");
  return lines.join("\n");
}

function buildWeixinHelpText() {
  return buildChannelHelpText("weixin");
}

function buildTelegramHelpText() {
  return buildChannelHelpText("telegram");
}

function buildChannelHelpText(channelId) {
  const channelKey = String(channelId || "").trim().toLowerCase();
  if (!channelKey) {
    return "💡 Available commands:";
  }
  const lines = ["💡 Available commands:"];
  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => {
      const list = Array.isArray(action[channelKey]) ? action[channelKey] : [];
      return action.status === "active" && list.length;
    });
    if (!activeActions.length) {
      continue;
    }
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${group.label}】`);
    for (const action of activeActions) {
      const examples = (Array.isArray(action[channelKey]) ? action[channelKey] : []).join(", ");
      lines.push(`  ${actionEmoji(action)} ${examples} — ${action.summary}`);
    }
  }
  return lines.join("\n");
}

function isCommandSupportedOnChannel(commandName, channelId) {
  const normalizedCommand = String(commandName || "").trim().toLowerCase();
  const channelKey = String(channelId || "").trim().toLowerCase();
  if (!normalizedCommand || !channelKey) {
    return false;
  }
  for (const group of COMMAND_GROUPS) {
    for (const action of group.actions) {
      if (action.status !== "active") continue;
      const list = Array.isArray(action[channelKey]) ? action[channelKey] : [];
      for (const entry of list) {
        const head = String(entry || "").trim().split(/\s+/)[0];
        if (!head) continue;
        if (head.replace(/^\//, "").toLowerCase() === normalizedCommand) {
          return true;
        }
      }
    }
  }
  return false;
}

function groupEmoji(groupId) {
  switch (groupId) {
    case "lifecycle": return "🔄";
    case "workspace": return "📁";
    case "approval": return "🔐";
    case "identity": return "🔗";
    case "capabilities": return "⚡️";
    default: return "•";
  }
}

function actionEmoji(action) {
  switch (action.action) {
    case "workspace.bind": return "📍";
    case "workspace.status": return "📊";
    case "thread.new": return "🆕";
    case "thread.reread": return "🔄";
    case "thread.compact": return "🗜️";
    case "thread.switch": return "🔀";
    case "thread.stop": return "⏹️";
    case "system.checkin_range": return "⏰";
    case "memory.recall": return "🧠";
    case "approval.accept_once": return "✅";
    case "approval.accept_workspace": return "💡";
    case "approval.reject_once": return "❌";
    case "identity.link_issue":
    case "identity.link_redeem": return "🔗";
    case "identity.unlink": return "✂️";
    case "model.inspect":
    case "model.select": return "🤖";
    case "app.help": return "❓";
    case "app.star": return "⭐️";
    default: return "•";
  }
}

module.exports = {
  buildTerminalHelpText,
  buildWeixinHelpText,
  buildTelegramHelpText,
  buildChannelHelpText,
  isCommandSupportedOnChannel,
  listCommandGroups,
};

function formatTerminalExamples(action) {
  const terminal = Array.isArray(action?.terminal) ? action.terminal : [];
  if (!terminal.length) {
    return "";
  }
  return terminal.map((commandText) => toTerminalCommandExample(commandText)).join(", ");
}

function toTerminalCommandExample(commandText) {
  const normalized = typeof commandText === "string" ? commandText.trim() : "";
  switch (normalized) {
    case "login":
    case "accounts":
    case "start":
    case "doctor":
    case "help":
    case "desire":
      return `cyberboss ${normalized}`;
    case "shared start":
    case "shared open":
    case "shared status":
      return `npm run ${normalized.replace(" ", ":")}`;
    case "start --checkin":
      return "cyberboss start --checkin";
    default:
      return normalized;
  }
}
