const { MementoStore } = require("./memento-store");
const { MementoAssets } = require("./memento-assets");
const { GiftService } = require("./gift-service");
const { PostcardService } = require("./postcard-service");
const { TravelCardService } = require("./travel-card-service");
const { MementoService } = require("./memento-service");

function createMementoServices(config) {
  const store = new MementoStore({ rootDir: config.mementoDir });
  const assets = new MementoAssets({ store });
  const gift = new GiftService({ store, assets });
  const postcard = new PostcardService({ store, assets });
  const travelCard = new TravelCardService({ store, assets });
  const memento = new MementoService({
    store,
    typeServices: { gift, postcard, travel_card: travelCard },
  });
  return { store, assets, gift, postcard, travelCard, memento };
}

module.exports = { createMementoServices };
