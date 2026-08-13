const { renderCard } = require("./renderers/svg-renderer");
const { attachAsset } = require("./gift-service");

class TravelCardService {
  constructor({ store, assets }) { this.store = store; this.assets = assets; }

  create(input = {}) {
    requireText(input.place, "place");
    requireText(input.moment, "moment");
    const mode = ["real", "imagined", "if"].includes(input.mode) ? input.mode : "imagined";
    const companions = Array.isArray(input.companions) && input.companions.length
      ? input.companions.map(text).filter(Boolean)
      : ["苏苏", "卫星"];
    const record = this.store.create({
      type: "travel_card",
      createdBy: text(input.createdBy) || "moonlet",
      givenTo: text(input.givenTo) || "both",
      status: "collected",
      data: {
        place: text(input.place),
        visitedAt: text(input.visitedAt) || new Date().toISOString(),
        companions,
        moment: text(input.moment),
        quote: text(input.quote),
        weather: text(input.weather),
        mode,
      },
    });
    const modeLabel = { real: "真实足迹", imagined: "想象旅行", if: "IF 世界" }[mode];
    const card = this.assets.writeSvg(record.id, "card", renderCard({
      eyebrow: `TRAVEL CARD · ${modeLabel}`,
      title: record.data.place,
      lines: [
        `${companions.join("、")}一起在这里`,
        record.data.moment,
        record.data.quote ? `“${record.data.quote}”` : "",
        record.data.weather ? `天气：${record.data.weather}` : "",
      ],
      footer: record.data.visitedAt,
      palette: { background: "#c9d0b1", panel: "#fffaf0", accent: "#63704c" },
    }));
    const saved = this.store.update(record.id, (current) => attachAsset(current, "card", card));
    return this.getView(saved.id, saved.givenTo);
  }

  getView(id, viewerId = "") {
    const record = typeof id === "string" ? this.store.read(id) : id;
    return {
      id: record.id,
      type: record.type,
      schemaVersion: record.schemaVersion,
      status: record.status,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
      givenTo: record.givenTo,
      viewerId: text(viewerId),
      publicData: { ...record.data },
      displayAsset: this.assets.resolve(record.assets.card),
      availableActions: [],
      callbackData: "",
    };
  }
}

function requireText(value, name) { if (!text(value)) throw new Error(`${name} is required`); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }

module.exports = { TravelCardService };
