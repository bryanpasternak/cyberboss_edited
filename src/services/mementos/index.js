const os = require("os");
const path = require("path");
const { MementoStore } = require("./memento-store");
const { MementoAssets } = require("./memento-assets");
const { GiftService } = require("./gift-service");
const { PostcardService } = require("./postcard-service");
const { TravelCardService } = require("./travel-card-service");
const { MementoService } = require("./memento-service");
const { createPostcardArtProvider } = require("./postcard-art-provider");
const { HtmlImageRenderer } = require("./renderers/html-image-renderer");
const { HtmlPostcardRenderer } = require("./renderers/html-postcard-renderer");

function createMementoServices(config, options = {}) {
  const store = new MementoStore({ rootDir: config.mementoDir });
  const assets = new MementoAssets({
    store,
    importRoots: [
      path.dirname(config.mementoDir),
      path.join(os.homedir(), ".codex", "generated_images"),
      path.join(process.cwd(), "output", "imagegen"),
    ],
  });
  const imageRenderer = options.postcardImageRenderer || new HtmlImageRenderer({
    browserExecutable: config.mementoBrowserExecutable,
  });
  const htmlRenderer = options.postcardHtmlRenderer || new HtmlPostcardRenderer({ imageRenderer });
  const artProvider = options.postcardArtProvider || createPostcardArtProvider({
    mode: config.postcardArtMode || "agent",
    theme: config.postcardArtTheme || "orbit-paper",
    apiProvider: options.postcardApiArtProvider,
  });
  const gift = new GiftService({ store, assets });
  const postcard = new PostcardService({ store, assets, htmlRenderer, artProvider });
  const travelCard = new TravelCardService({ store, assets });
  const memento = new MementoService({
    store,
    typeServices: { gift, postcard, travel_card: travelCard },
  });
  return { store, assets, gift, postcard, travelCard, memento };
}

module.exports = { createMementoServices };
