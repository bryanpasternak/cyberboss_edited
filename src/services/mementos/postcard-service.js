const { renderCard, renderPostcardBack } = require("./renderers/svg-renderer");
const { attachAsset } = require("./gift-service");

class PostcardService {
  constructor({ store, assets }) { this.store = store; this.assets = assets; }

  send(input = {}) {
    requireText(input.message, "message");
    const from = text(input.from) || "卫星";
    const to = text(input.to) || "苏苏";
    const date = text(input.date) || new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const record = this.store.create({
      type: "postcard",
      createdBy: text(input.createdBy) || "moonlet",
      givenTo: text(input.givenTo) || "susu",
      status: "sent",
      data: {
        from, to, date,
        message: text(input.message),
        frontTitle: text(input.frontTitle) || "从哥哥这里寄往小鱿身边",
        frontCaption: text(input.frontCaption) || "有些想念只占一张明信片那么大。",
        stamp: text(input.stamp) || "月亮邮票",
      },
    });
    const front = this.assets.writeSvg(record.id, "front", renderCard({
      eyebrow: "POSTCARD",
      title: record.data.frontTitle,
      lines: [record.data.frontCaption],
      footer: `${from} → ${to} · ${date}`,
      palette: { background: "#a8c3c4", panel: "#fff8e9", accent: "#476f75" },
    }));
    const back = this.assets.writeSvg(record.id, "back", renderPostcardBack(record.data));
    const saved = this.store.update(record.id, (current) => attachAsset(attachAsset(current, "front", front), "back", back));
    return this.getView(saved.id, saved.givenTo, "front");
  }

  flip({ id, actorId = "susu", side = "back" } = {}) {
    const record = this.store.read(id);
    if (record.type !== "postcard") throw new Error(`Not a postcard: ${id}`);
    const targetSide = side === "front" ? "front" : "back";
    if (record.status === "sent") this.store.update(id, (current) => ({ ...current, status: "received" }));
    return this.getView(id, actorId, targetSide);
  }

  getView(id, viewerId = "", side = "front") {
    const record = typeof id === "string" ? this.store.read(id) : id;
    const displaySide = side === "back" ? "back" : "front";
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
      availableActions: ["flip"],
      callbackData: `postcard:flip:${record.id}:${displaySide === "front" ? "back" : "front"}`,
    };
  }
}

function requireText(value, name) { if (!text(value)) throw new Error(`${name} is required`); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { PostcardService };
