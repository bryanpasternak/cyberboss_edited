const { POSTCARD_LAYOUTS } = require("./postcard-layout-policy");

class AgentPostcardArtProvider {
  constructor({ theme = "orbit-paper" } = {}) {
    this.mode = "agent";
    this.theme = text(theme) || "orbit-paper";
  }

  async prepare({ visualBrief, layout }) {
    const brief = text(visualBrief);
    if (!brief) throw new Error("visualBrief is required for illustrated postcards");
    return {
      kind: "handoff",
      mode: this.mode,
      prompt: buildAgentImagePrompt({ visualBrief: brief, layout, theme: this.theme }),
      aspectRatio: "3:2",
      constraints: ["no text", "no letters", "no numbers", "no logo", "no watermark"],
    };
  }
}

class BuiltinPostcardArtProvider {
  constructor({ theme = "orbit-paper" } = {}) {
    this.mode = "builtin";
    this.theme = text(theme) || "orbit-paper";
  }

  async prepare() {
    return { kind: "builtin", mode: this.mode, theme: this.theme };
  }
}

class UnconfiguredApiPostcardArtProvider {
  constructor() { this.mode = "api"; }

  async prepare() {
    throw new Error("Postcard API art provider is not configured. Use agent or builtin mode.");
  }
}

function createPostcardArtProvider({ mode = "agent", theme = "orbit-paper", apiProvider } = {}) {
  const normalized = text(mode).toLowerCase() || "agent";
  if (normalized === "api") return apiProvider || new UnconfiguredApiPostcardArtProvider();
  if (normalized === "builtin") return new BuiltinPostcardArtProvider({ theme });
  return new AgentPostcardArtProvider({ theme });
}

function buildAgentImagePrompt({ visualBrief, layout, theme = "orbit-paper" }) {
  const composition = layout === POSTCARD_LAYOUTS.SHORT_NOTE
    ? "Landscape 3:2. Keep the visual focus in the right half and leave calm, low-detail breathing room on the left for editorial typography."
    : layout === POSTCARD_LAYOUTS.LONG_LETTER
      ? "Landscape 3:2. Compose it like an illustrated envelope or archival keepsake: details around the outer edges, with a calm open center that can also become a faint letter-paper watermark."
      : "Landscape 3:2. One strong visual motif with generous quiet negative space for a short literary caption.";
  return [
    "Use case: stylized-concept",
    "Asset type: illustrated postcard artwork without typography",
    `Primary request: ${text(visualBrief)}`,
    `Series language: ${theme}; intimate editorial illustration, restrained watercolor or gouache, subtle ink contours, tactile handmade paper grain`,
    `Composition/framing: ${composition}`,
    "Constraints: absolutely no text, no letters, no numbers, no logo, no watermark, no UI, no border; keep the composition clean and emotionally specific",
  ].join("\n");
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = {
  AgentPostcardArtProvider,
  BuiltinPostcardArtProvider,
  UnconfiguredApiPostcardArtProvider,
  buildAgentImagePrompt,
  createPostcardArtProvider,
};
