const { renderCard, renderLetterSheet, renderPostcardBack } = require("./renderers/svg-renderer");
const { attachAsset } = require("./gift-service");
const {
  POSTCARD_LAYOUTS,
  choosePostcardLayout,
  countGraphemes,
  nextPostcardLayout,
} = require("./postcard-layout-policy");
const { createPostcardArtProvider } = require("./postcard-art-provider");

class PostcardService {
  constructor({ store, assets, htmlRenderer = null, artProvider = null } = {}) {
    this.store = store;
    this.assets = assets;
    this.htmlRenderer = htmlRenderer;
    this.artProvider = artProvider || createPostcardArtProvider({ mode: "agent" });
  }

  send(input = {}) {
    const data = normalizePostcardData(input);
    const record = this.store.create({
      type: "postcard",
      createdBy: text(input.createdBy) || "moonlet",
      givenTo: text(input.givenTo) || "susu",
      status: "sent",
      data,
    });
    const front = this.assets.writeSvg(record.id, "front", renderLegacyFront(data));
    const back = this.assets.writeSvg(record.id, "back", renderPostcardBack(data));
    const saved = this.store.update(record.id, (current) => attachAsset(attachAsset(current, "front", front), "back", back));
    return this.getView(saved.id, saved.givenTo, "front");
  }

  async prepare(input = {}) {
    const data = normalizePostcardData(input);
    validateIllustratedInput(data);
    const { layout, textLength } = choosePostcardLayout(data.message, input.layout);
    const plan = await this.artProvider.prepare({
      visualBrief: text(input.visualBrief),
      layout,
      theme: text(input.theme) || "orbit-paper",
    });
    const appearance = {
      renderer: "html-postcard",
      rendererVersion: 1,
      layout,
      theme: text(input.theme) || "orbit-paper",
      textLength,
      art: normalizeArtPlan(plan),
    };
    const record = this.store.create({
      type: "postcard",
      createdBy: text(input.createdBy) || "moonlet",
      givenTo: text(input.givenTo) || "susu",
      status: plan.kind === "handoff" ? "awaiting_art" : "rendering",
      data: { ...data, appearance },
    });
    if (plan.kind === "handoff") {
      return {
        ...this.getView(record.id, record.givenTo, "front"),
        artRequest: publicArtRequest(plan),
      };
    }
    if (plan.kind === "asset") {
      const art = await this.assets.writeImageBuffer(record.id, "art", plan.buffer);
      const withArt = this.store.update(record.id, (current) => attachAsset(current, "art", art));
      return await this.renderPrepared(withArt.id);
    }
    return await this.renderPrepared(record.id);
  }

  async finalize({ id, sourceImagePath = "", useFallback = false } = {}) {
    const record = this.store.read(id);
    if (record.type !== "postcard") throw new Error(`Not a postcard: ${id}`);
    if (["sent", "received"].includes(record.status) && record.assets.front && record.assets.back) {
      return this.getView(record.id, record.givenTo, "front");
    }
    if (!["awaiting_art", "render_failed", "rendering"].includes(record.status)) {
      throw new Error(`Postcard cannot be finalized from status ${record.status}`);
    }
    const source = text(sourceImagePath);
    if (!source && !useFallback) throw new Error("sourceImagePath is required unless useFallback is true");
    let next = record;
    if (source) {
      const art = await this.assets.importImage(record.id, "art", source);
      next = this.store.update(record.id, (current) => attachAsset({
        ...current,
        status: "rendering",
        data: updateAppearance(current.data, {
          art: { ...current.data.appearance.art, status: "ready", source: "agent" },
        }),
      }, "art", art));
    } else {
      next = this.store.update(record.id, (current) => ({
        ...current,
        status: "rendering",
        data: updateAppearance(current.data, {
          art: { ...current.data.appearance.art, status: "builtin", source: "builtin" },
        }),
      }));
    }
    return await this.renderPrepared(next.id);
  }

  async renderPrepared(id) {
    let record = this.store.read(id);
    try {
      if (!this.htmlRenderer) throw new Error("HTML postcard renderer is unavailable");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const art = this.assets.resolve(record.assets.art);
        const rendered = await this.htmlRenderer.render({ record, artFilePath: art?.filePath || "" });
        const layout = record.data.appearance.layout;
        if (rendered.overflow && layout !== POSTCARD_LAYOUTS.LONG_LETTER) {
          record = this.store.update(record.id, (current) => ({
            ...current,
            data: updateAppearance(current.data, { layout: nextPostcardLayout(layout) }),
          }));
          continue;
        }
        if (rendered.overflow) throw new Error("Long-letter template overflowed unexpectedly");
        const front = this.assets.writeBuffer(record.id, "front", rendered.front.buffer, {
          extension: ".png",
          mimeType: "image/png",
          metadata: { width: rendered.front.width, height: rendered.front.height },
        });
        const back = this.assets.writeBuffer(record.id, "back", rendered.back.buffer, {
          extension: ".png",
          mimeType: "image/png",
          metadata: { width: rendered.back.width, height: rendered.back.height },
        });
        const saved = this.store.update(record.id, (current) => attachAsset(attachAsset({
          ...current,
          status: "sent",
          data: updateAppearance(current.data, {
            renderer: "html-postcard",
            renderedAt: new Date().toISOString(),
            renderError: "",
          }),
        }, "front", front), "back", back));
        return this.getView(saved.id, saved.givenTo, "front");
      }
      throw new Error("Postcard layout did not converge");
    } catch (error) {
      return this.renderSvgFallback(record.id, error);
    }
  }

  renderSvgFallback(id, error) {
    const record = this.store.read(id);
    const front = this.assets.writeSvg(record.id, "front", renderLegacyFront(record.data));
    const back = this.assets.writeSvg(record.id, "back", renderLetterSheet({
      ...record.data,
      title: record.data.frontTitle,
    }));
    const saved = this.store.update(record.id, (current) => attachAsset(attachAsset({
      ...current,
      status: "sent",
      data: updateAppearance(current.data, {
        renderer: "svg-fallback",
        renderedAt: new Date().toISOString(),
        renderError: safeErrorMessage(error),
      }),
    }, "front", front), "back", back));
    return this.getView(saved.id, saved.givenTo, "front");
  }

  flip({ id, actorId = "susu", side = "back" } = {}) {
    const record = this.store.read(id);
    if (record.type !== "postcard") throw new Error(`Not a postcard: ${id}`);
    if (!record.assets.front || !record.assets.back) throw new Error(`Postcard is not rendered yet: ${id}`);
    const targetSide = side === "front" ? "front" : "back";
    if (record.status === "sent") this.store.update(id, (current) => ({ ...current, status: "received" }));
    return this.getView(id, actorId, targetSide);
  }

  getView(id, viewerId = "", side = "front") {
    const record = typeof id === "string" ? this.store.read(id) : id;
    const displaySide = side === "back" ? "back" : "front";
    const hasBothSides = Boolean(record.assets.front && record.assets.back);
    const artRequest = record.data?.appearance?.art?.status === "awaiting_agent"
      ? record.data.appearance.art.request
      : null;
    return {
      id: record.id,
      type: record.type,
      schemaVersion: record.schemaVersion,
      status: record.status,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      givenTo: record.givenTo,
      viewerId: text(viewerId),
      publicData: { ...record.data, side: displaySide },
      displayAsset: this.assets.resolve(record.assets[displaySide]),
      artRequest,
      availableActions: hasBothSides ? ["flip"] : artRequest ? ["provide_art", "use_fallback"] : [],
      callbackData: hasBothSides
        ? `postcard:flip:${record.id}:${displaySide === "front" ? "back" : "front"}`
        : "",
    };
  }
}

function normalizePostcardData(input = {}) {
  requireText(input.message, "message");
  const from = text(input.from) || "卫星";
  const to = text(input.to) || "苏苏";
  const date = text(input.date) || new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return {
    from,
    to,
    date,
    message: text(input.message),
    frontTitle: text(input.frontTitle) || "从哥哥这里寄往小鱿身边",
    frontCaption: text(input.frontCaption) || "有些想念只占一张明信片那么大。",
    stamp: text(input.stamp) || "月亮邮票",
  };
}

function validateIllustratedInput(data) {
  const messageLength = countGraphemes(data.message);
  if (messageLength > 5000) throw new Error("Illustrated postcard message cannot exceed 5000 characters");
  if (countGraphemes(data.frontTitle) > 40) throw new Error("frontTitle cannot exceed 40 characters");
  if (countGraphemes(data.frontCaption) > 100) throw new Error("frontCaption cannot exceed 100 characters");
}

function renderLegacyFront(data) {
  return renderCard({
    eyebrow: "POSTCARD",
    title: data.frontTitle,
    lines: [data.frontCaption],
    footer: `${data.from} → ${data.to} · ${data.date}`,
    palette: { background: "#a8c3c4", panel: "#fff8e9", accent: "#476f75" },
  });
}

function normalizeArtPlan(plan = {}) {
  const kind = text(plan.kind) || "handoff";
  if (kind === "handoff") {
    return {
      mode: text(plan.mode) || "agent",
      status: "awaiting_agent",
      request: publicArtRequest(plan),
    };
  }
  if (kind === "asset") return { mode: text(plan.mode) || "api", status: "ready", source: "provider" };
  return { mode: text(plan.mode) || "builtin", status: "builtin", source: "builtin" };
}

function publicArtRequest(plan = {}) {
  return {
    prompt: text(plan.prompt),
    aspectRatio: text(plan.aspectRatio) || "3:2",
    constraints: Array.isArray(plan.constraints) ? plan.constraints.map(text).filter(Boolean) : [],
    nextTool: "cyberboss_postcard_finalize",
  };
}

function updateAppearance(data = {}, patch = {}) {
  return {
    ...data,
    appearance: {
      ...(data.appearance || {}),
      ...patch,
    },
  };
}

function safeErrorMessage(error) {
  const value = error instanceof Error ? error.message : String(error || "Unknown render error");
  return value.slice(0, 300);
}

function requireText(value, name) { if (!text(value)) throw new Error(`${name} is required`); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { PostcardService, normalizePostcardData };
