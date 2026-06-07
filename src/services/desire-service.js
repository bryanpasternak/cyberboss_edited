const {
  DRIVE_KEYS,
  computeScores,
  pickIntent,
  tick,
  satisfy,
  feedThought,
  autofeedActionThought,
  autofeedVoiceThought,
  buildDesirePromptText,
  normalizeState,
} = require("./desire/desire-engine");
const { DesireStore } = require("./desire/desire-store");
const { scanTriggers } = require("./desire/desire-trigger");

class DesireService {
  constructor({ store, drivenEnabled = false, thoughtMax = 80 } = {}) {
    if (!store) {
      throw new Error("DesireService requires a store");
    }
    this.store = store;
    this.drivenEnabled = Boolean(drivenEnabled);
    this.thoughtMax = Math.max(1, Number.parseInt(thoughtMax, 10) || 80);
    this.ensureInitialized();
  }

  ensureInitialized() {
    const state = this.store.load();
    const shouldApplyEnvDefault = typeof this.store.exists === "function" ? !this.store.exists() : false;
    if (shouldApplyEnvDefault && state.drivenBehaviorEnabled !== this.drivenEnabled) {
      this.store.save({
        ...state,
        drivenBehaviorEnabled: this.drivenEnabled,
      });
    }
  }

  getState() {
    return normalizeState(this.store.load());
  }

  getSnapshot() {
    const state = this.getState();
    const scores = computeScores(state.drive, state.thoughts);
    const intent = pickIntent(state);
    return {
      state,
      drive: state.drive,
      scores,
      intent,
      availableActions: ["web_browse", "flirt", "reflect", "follow_up", "seduce", "vent", "none"],
      thoughtCount: state.thoughts.length,
      thoughts: state.thoughts,
      drivenBehaviorEnabled: state.drivenBehaviorEnabled,
    };
  }

  tick(nowMs = Date.now()) {
    return this.store.update((state) => this.trimThoughts(tick(state, nowMs)));
  }

  getIntent() {
    return pickIntent(this.getState());
  }

  satisfyAction(action) {
    return this.store.update((state) => satisfy(state, action));
  }

  feedThought(text, drive, kind = "flit", strength = 0.5) {
    return this.store.update((state) => this.trimThoughts(feedThought(state, {
      text,
      drive,
      kind,
      strength,
    })));
  }

  autofeedActionThought(text, action) {
    return this.store.update((state) => this.trimThoughts(autofeedActionThought(state, text, action)));
  }

  autofeedVoiceThought(text) {
    return this.store.update((state) => this.trimThoughts(autofeedVoiceThought(state, text)));
  }

  toggleDriven(enabled) {
    return this.store.update((state) => ({
      ...state,
      drivenBehaviorEnabled: Boolean(enabled),
    }));
  }

  /**
   * 扫描用户消息中的关键词，自动提升对应驱动值。
   * 每组分词有冷却时间防止反复触发。
   * @param {string} text - 用户消息文本
   * @returns {{ triggered: string[], boosts: Object<string,number> }}
   */
  scanTextTriggers(text) {
    if (!this._triggerLastHits) {
      this._triggerLastHits = {};
    }
    const result = scanTriggers(text, Date.now(), this._triggerLastHits);
    this._triggerLastHits = result.nextLastHits;

    const boostEntries = Object.entries(result.boosts);
    if (!boostEntries.length) {
      return { triggered: [], boosts: {} };
    }

    this.store.update((state) => {
      const drive = { ...state.drive };
      for (const [key, amount] of boostEntries) {
        const current = Number(drive[key]) || 0;
        drive[key] = Math.round(Math.min(1, current + amount) * 10000) / 10000;
      }
      return { ...state, drive };
    });

    if (result.triggered.length) {
      console.log(`[desire] trigger hit: keywords=${result.triggered.join(",")} boosts=${JSON.stringify(result.boosts)}`);
    }
    return { triggered: result.triggered, boosts: result.boosts };
  }

  buildDesireSystemMessage() {
    const state = this.getState();
    if (!state.drivenBehaviorEnabled) {
      return "";
    }
    return buildDesirePromptText(pickIntent(state));
  }

  trimThoughts(state) {
    const normalized = normalizeState(state);
    if (normalized.thoughts.length <= this.thoughtMax) {
      return normalized;
    }
    const fixations = normalized.thoughts.filter((thought) => thought.kind === "fixation");
    const flits = normalized.thoughts
      .filter((thought) => thought.kind !== "fixation")
      .sort((left, right) => {
        if (left.strength !== right.strength) {
          return right.strength - left.strength;
        }
        return right.bornAt - left.bornAt;
      });
    const thoughts = [...fixations, ...flits]
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "fixation" ? -1 : 1;
        }
        if (left.strength !== right.strength) {
          return right.strength - left.strength;
        }
        return right.bornAt - left.bornAt;
      })
      .slice(0, this.thoughtMax);
    return {
      ...normalized,
      thoughts,
    };
  }
}

function createDesireService(config, options = {}) {
  const store = options.store || new DesireStore({
    filePath: config.desireStateFile,
  });
  return new DesireService({
    store,
    drivenEnabled: options.drivenEnabled ?? config.desireDriven,
    thoughtMax: options.thoughtMax ?? config.desireThoughtMax,
  });
}

module.exports = {
  DRIVE_KEYS,
  DesireService,
  createDesireService,
};
