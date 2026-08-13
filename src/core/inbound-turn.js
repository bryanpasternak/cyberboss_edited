const {
  STICKER_DESC_GUIDANCE,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");

function buildInboundDraft(normalized, { attachments = [], attachmentFailures = [] } = {}) {
  const originalText = normalizeText(normalized?.text);
  return {
    ...normalized,
    originalText,
    text: originalText,
    attachments: Array.isArray(attachments) ? attachments : [],
    attachmentFailures: Array.isArray(attachmentFailures) ? attachmentFailures : [],
  };
}

function buildMergedInboundPrepared({
  bindingKey,
  workspaceRoot,
  messages = [],
  trailingPrepared = null,
}) {
  const queued = Array.isArray(messages) ? messages.filter((message) => message && typeof message === "object") : [];
  const latest = trailingPrepared || queued[queued.length - 1] || {};
  const originalTexts = queued
    .map((message) => normalizeText(message.originalText))
    .filter(Boolean);
  const trailingText = normalizeText(trailingPrepared?.originalText);
  if (trailingText) {
    originalTexts.push(trailingText);
  }
  const attachments = queued.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []);
  const attachmentFailures = queued.flatMap((message) => Array.isArray(message.attachmentFailures) ? message.attachmentFailures : []);
  const originalText = originalTexts.join("\n\n");

  return {
    bindingKey,
    workspaceRoot,
    ...latest,
    originalText,
    text: originalText,
    attachments,
    attachmentFailures,
  };
}

function assembleRuntimeTurnText({ prepared, config = {}, visionContext = {} }) {
  const lines = [];
  const localTime = formatWechatLocalTime(prepared?.receivedAt);
  const channelLabel = formatInboundChannelLabel(prepared?.channelId || prepared?.provider);
  const originalText = normalizeText(prepared?.originalText ?? prepared?.text);
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const attachmentFailures = Array.isArray(prepared?.attachmentFailures) ? prepared.attachmentFailures : [];
  const imageAttachments = attachments.filter((item) => isImageAttachmentItem(item));
  const visualItems = Array.isArray(visionContext.items) ? visionContext.items : [];
  const visionErrors = Array.isArray(visionContext.errors) ? visionContext.errors : [];

  if (localTime || channelLabel) {
    const heading = [channelLabel, localTime].filter(Boolean).join(" · ");
    lines.push(`[${heading}]`);
  }
  if (originalText) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(originalText);
  }

  if (attachments.length) {
    pushSectionBreak(lines);
    lines.push("Saved attachments:");
    for (const item of attachments) {
      const suffix = item.sourceFileName ? ` (original name: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind || "attachment"}] ${item.absolutePath}${suffix}`);
    }
    lines.push("Use the saved local files if they are needed for the request.");
  }

  if (visualItems.length) {
    pushSectionBreak(lines);
    lines.push("Visual context from attachments:");
    for (const item of visualItems) {
      const source = normalizeText(item.absolutePath) || normalizeText(item.sourceFileName) || "image";
      lines.push(`- ${source}: ${normalizeText(item.description)}`);
    }
  }

  if (imageAttachments.length) {
    pushSectionBreak(lines);
    // 👇 新增：说明书要求的识图模块指令
    lines.push("If your model has native vision, use `Read` on each image.");
    lines.push("If your model does NOT have vision (e.g. DeepSeek), for EVERY image run:");
    lines.push('  node scripts/vision.js "<path>" "请用中文描述这张图片的内容"');
    lines.push("Say nothing before all images are processed.");
    
    // 👇 原有的表情包/贴纸逻辑保留，井水不犯河水
    lines.push(`If some images are reusable stickers, load \`cyberboss_sticker_tags\` only when needed. ${STICKER_TAG_GUIDANCE}`);
    lines.push(`To save reusable stickers, call \`cyberboss_sticker_save_from_inbox\` once with an \`items\` array. Use 1-3 tags. ${STICKER_DESC_GUIDANCE} Skip ordinary photos, screenshots, and unclear images.`);
    lines.push("Do not describe save steps. The system sends the sticker notice.");
  }

  if (attachmentFailures.length || visionErrors.length) {
    pushSectionBreak(lines);
    lines.push("Attachment intake errors:");
    for (const item of attachmentFailures) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
    for (const item of visionErrors) {
      const label = item.absolutePath || item.sourceFileName || item.kind || "image";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
}

function shouldBatchImageOnlyInbound(message) {
  const originalText = normalizeText(message?.originalText);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentFailures = Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : [];
  return !originalText
    && attachments.length > 0
    && attachments.every((item) => isImageAttachmentItem(item))
    && attachmentFailures.length === 0;
}

function takeImageOnlyBatchMessages(messages, maxAttachments) {
  const batchMessages = [];
  const remainingMessages = [];
  let remainingCapacity = Math.max(1, Number(maxAttachments) || 1);

  for (const message of Array.isArray(messages) ? messages : []) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length) {
      continue;
    }
    if (remainingCapacity <= 0) {
      remainingMessages.push(message);
      continue;
    }
    if (attachments.length <= remainingCapacity) {
      batchMessages.push(message);
      remainingCapacity -= attachments.length;
      continue;
    }
    batchMessages.push({
      ...message,
      attachments: attachments.slice(0, remainingCapacity),
    });
    remainingMessages.push({
      ...message,
      attachments: attachments.slice(remainingCapacity),
    });
    remainingCapacity = 0;
  }

  return {
    batchMessages,
    remainingMessages,
  };
}

function clonePreparedInboundMessage(prepared) {
  return {
    workspaceId: prepared.workspaceId,
    accountId: prepared.accountId,
    senderId: prepared.senderId,
    messageId: prepared.messageId,
    contextToken: prepared.contextToken,
    provider: prepared.provider,
    channelId: prepared.channelId,
    originalText: prepared.originalText,
    text: prepared.text,
    attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
    attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
    receivedAt: prepared.receivedAt,
  };
}

function isPlainTextPreparedMessage(prepared) {
  const originalText = normalizeText(prepared?.originalText);
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const attachmentFailures = Array.isArray(prepared?.attachmentFailures) ? prepared.attachmentFailures : [];
  return Boolean(originalText) && attachments.length === 0 && attachmentFailures.length === 0;
}

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function pushSectionBreak(lines) {
  if (lines.length) {
    lines.push("");
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function formatInboundChannelLabel(channelId) {
  const normalized = normalizeText(channelId).toLowerCase();
  if (normalized === "telegram") {
    return "Telegram";
  }
  if (normalized === "qq") {
    return "QQ";
  }
  if (normalized === "weixin" || normalized === "wechat") {
    return "微信";
  }
  return "";
}

module.exports = {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isImageAttachmentItem,
  isPlainTextPreparedMessage,
  formatInboundChannelLabel,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
};
