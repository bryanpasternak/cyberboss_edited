const crypto = require("crypto");

const DEFAULT_LOCAL_DIMENSION = 512;

class EmbeddingClient {
  constructor({ config = {} } = {}) {
    this.config = config;
    this.provider = normalizeText(config.chatMemoryEmbedProvider) || "local-hashed-ngram-512";
    this.baseUrl = normalizeText(config.chatMemoryEmbedBaseUrl);
    this.model = normalizeText(config.chatMemoryEmbedModel) || "local-hashed-ngram-512";
    this.apiKey = normalizeText(config.chatMemoryEmbedApiKey)
      || normalizeText(process.env.DASHSCOPE_API_KEY)
      || normalizeText(process.env.OPENAI_API_KEY);
  }

  async embedText(text) {
    const [embedding] = await this.embedTexts([text]);
    return embedding || [];
  }

  async embedTexts(texts) {
    const inputs = Array.isArray(texts) ? texts.map((item) => String(item || "")) : [];
    if (!inputs.length) {
      return [];
    }
    if (this.shouldUseRemoteProvider()) {
      try {
        return await this.embedTextsRemote(inputs);
      } catch (error) {
        console.warn(`[chat-memory] embedding provider failed, using local fallback: ${error.message}`);
      }
    }
    return inputs.map((text) => localHashedEmbedding(text));
  }

  shouldUseRemoteProvider() {
    const provider = this.provider.toLowerCase();
    return (provider === "dashscope-openai-compatible" || provider === "openai-compatible")
      && this.baseUrl
      && this.apiKey
      && typeof fetch === "function";
  }

  async embedTextsRemote(texts) {
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });
    if (!response.ok) {
      throw new Error(`embedding HTTP ${response.status}`);
    }
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const byIndex = new Map(data.map((entry, index) => [
      Number.isInteger(entry?.index) ? entry.index : index,
      Array.isArray(entry?.embedding) ? entry.embedding.map(Number) : [],
    ]));
    return texts.map((_, index) => byIndex.get(index) || localHashedEmbedding(texts[index]));
  }
}

function localHashedEmbedding(text, dimension = DEFAULT_LOCAL_DIMENSION) {
  const vector = new Array(dimension).fill(0);
  const tokens = tokenizeForEmbedding(text);
  if (!tokens.length) {
    return vector;
  }
  for (const token of tokens) {
    const hash = crypto.createHash("sha256").update(token).digest();
    const index = hash.readUInt32BE(0) % dimension;
    const sign = hash[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  return normalizeVector(vector);
}

function tokenizeForEmbedding(text) {
  const normalized = String(text || "").toLowerCase();
  const ascii = normalized.match(/[a-z0-9_]{2,}/g) || [];
  const chinese = normalized.match(/[\u4e00-\u9fff]/g) || [];
  const chars = [...ascii, ...chinese];
  const grams = [];
  for (let index = 0; index < chinese.length - 1; index += 1) {
    grams.push(`${chinese[index]}${chinese[index + 1]}`);
  }
  return [...chars, ...grams];
}

function normalizeVector(vector) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) {
    return vector;
  }
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
    return 0;
  }
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let index = 0; index < length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftMag += a * a;
    rightMag += b * b;
  }
  if (!leftMag || !rightMag) {
    return 0;
  }
  return dot / Math.sqrt(leftMag * rightMag);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_LOCAL_DIMENSION,
  EmbeddingClient,
  cosineSimilarity,
  localHashedEmbedding,
  tokenizeForEmbedding,
};
