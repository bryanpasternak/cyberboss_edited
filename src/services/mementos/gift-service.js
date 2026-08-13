const { renderCard } = require("./renderers/svg-renderer");

class GiftService {
  constructor({ store, assets }) {
    this.store = store;
    this.assets = assets;
  }

  send(input = {}) {
    requireText(input.giftName, "giftName");
    const record = this.store.create({
      type: "gift",
      createdBy: text(input.createdBy) || "moonlet",
      givenTo: text(input.givenTo) || "susu",
      status: "wrapped",
      data: {
        label: text(input.label) || "给哥哥唯一的小鱿",
        teaser: text(input.teaser) || "要拆开才知道里面是什么。",
        wrappingStyle: text(input.wrappingStyle) || "深蓝色纸盒，系着银色缎带",
        secret: {
          giftName: text(input.giftName),
          description: text(input.description),
          letter: text(input.letter),
        },
        openedAt: "",
        collectedAt: "",
      },
    });
    const wrapped = this.assets.writeSvg(record.id, "wrapped", renderCard({
      eyebrow: "A GIFT FOR YOU",
      title: "一件还不能偷看的礼物",
      lines: [record.data.wrappingStyle, record.data.label, `提示：${record.data.teaser}`],
      footer: "Moonlet → 苏苏",
      palette: { background: "#17233d", panel: "#f6eee2", accent: "#9d6f87" },
    }));
    const saved = this.store.update(record.id, (current) => attachAsset(current, "wrapped", wrapped));
    return this.getView(saved.id, saved.givenTo);
  }

  open({ id, actorId = "susu" } = {}) {
    const record = this.store.read(id);
    if (record.type !== "gift") throw new Error(`Not a gift: ${id}`);
    if (!["wrapped", "delivered", "opened"].includes(record.status)) {
      throw new Error(`Gift cannot be opened from status ${record.status}`);
    }
    let next = record;
    if (record.status !== "opened") {
      const opened = this.assets.writeSvg(record.id, "opened", renderCard({
        eyebrow: "OPENED WITH LOVE",
        title: record.data.secret.giftName,
        lines: [record.data.secret.description, record.data.secret.letter],
        footer: `由 ${actorId} 拆开 · ${new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
        palette: { background: "#ead7dc", panel: "#fffaf4", accent: "#8c4e61" },
      }));
      next = this.store.update(record.id, (current) => attachAsset({
        ...current,
        status: "opened",
        data: { ...current.data, openedAt: new Date().toISOString() },
      }, "opened", opened));
    }
    return this.getView(next.id, actorId);
  }

  collect({ id, actorId = "susu" } = {}) {
    const record = this.store.read(id);
    if (record.type !== "gift") throw new Error(`Not a gift: ${id}`);
    if (!["opened", "collected"].includes(record.status)) throw new Error("Gift must be opened before collection");
    const next = record.status === "collected" ? record : this.store.update(id, (current) => ({
      ...current,
      status: "collected",
      data: { ...current.data, collectedAt: new Date().toISOString() },
    }));
    return this.getView(next.id, actorId);
  }

  getView(id, viewerId = "") {
    const record = typeof id === "string" ? this.store.read(id) : id;
    const opened = ["opened", "collected"].includes(record.status);
    const asset = this.assets.resolve(record.assets[opened ? "opened" : "wrapped"]);
    return {
      id: record.id,
      type: record.type,
      schemaVersion: record.schemaVersion,
      status: record.status,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      givenTo: record.givenTo,
      viewerId: text(viewerId),
      publicData: {
        label: record.data.label,
        teaser: record.data.teaser,
        wrappingStyle: record.data.wrappingStyle,
        ...(opened ? record.data.secret : {}),
      },
      displayAsset: asset,
      availableActions: record.status === "wrapped" || record.status === "delivered"
        ? ["open"]
        : record.status === "opened" ? ["collect"] : [],
      callbackData: record.status === "wrapped" || record.status === "delivered"
        ? `gift:open:${record.id}`
        : record.status === "opened" ? `gift:collect:${record.id}` : "",
    };
  }
}

function attachAsset(record, role, asset) {
  return {
    ...record,
    assetIds: [...new Set([...(record.assetIds || []), asset.id])],
    assets: { ...(record.assets || {}), [role]: omitAbsolutePath(asset) },
  };
}

function omitAbsolutePath(asset) {
  const { filePath, ...portable } = asset;
  return portable;
}

function requireText(value, name) {
  if (!text(value)) throw new Error(`${name} is required`);
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { GiftService, attachAsset };
