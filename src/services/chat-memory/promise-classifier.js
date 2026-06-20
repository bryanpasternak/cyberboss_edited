// const SYSTEM_PROMPT = [
//   "你是一个判断中文消息是否构成“承诺/约定”的分类器。",
//   "承诺指：说话者明确答应去做某件事，带有可被对方回头核对的行动意图。",
//   "不是承诺的情况：陈述事实、抱怨、提问、闲聊、不确定的设想、对方在催促但说话者没明确答应。",
//   "只输出一个严格 JSON 对象，不要任何解释或 markdown：",
//   '{"is_promise": true|false, "confidence": 0-1 之间的小数, "reason": "中文短理由"}',
// ].join("\n");

const SYSTEM_PROMPT = `
你是一个判断中文消息是否构成"承诺/约定"的分类器。利用语言常识判断，但受以下严格边界约束。

【承诺的定义（严格）】
承诺 = 说话人约束自己，答应未来执行（或不执行）某个具体、可被对方核对的行动。
必须同时满足：
- 主语是说话人自己（"我"或默认"我"）
- 包含具体的动词动作（带、修、还、做、停止、不再、保证等）
- 可以被客观验证是否完成

【唯一硬特例（无需满足上述"具体动词"条件）】
如果文本明确表达了"记账"、"欠着"的债务语义（如"记你账上"、"先欠着"、"给你记着"、"这笔账记了"），直接判 true。这是系统硬规则，不解释。

输出格式：{"is_promise": true|false, "confidence": 0.95, "reason": "10字内中文理由"}
`.trim();

class PromiseClassifier {
  constructor({ config = {} } = {}) {
    this.enabled = Boolean(config.promiseClassifierEnabled);
    this.provider = normalizeText(config.promiseClassifierProvider).toLowerCase() || "openai-compatible";
    this.baseUrl = normalizeText(config.promiseClassifierBaseUrl);
    this.apiKey = normalizeText(config.promiseClassifierApiKey);
    this.model = normalizeText(config.promiseClassifierModel);
    this.timeoutMs = Math.max(1000, Number(config.promiseClassifierTimeoutMs) || 15000);
    this.verbose = Boolean(config.promiseClassifierVerbose);
    this.proxyUrl = normalizeText(config.promiseClassifierProxy)
      || normalizeText(process.env.HTTPS_PROXY)
      || normalizeText(process.env.https_proxy)
      || normalizeText(process.env.HTTP_PROXY)
      || normalizeText(process.env.http_proxy)
      || normalizeText(process.env.ALL_PROXY)
      || normalizeText(process.env.all_proxy);
    const undiciHandles = loadUndici();
    this.undiciFetch = undiciHandles.fetch || null;
    this.dispatcher = this.proxyUrl && undiciHandles.ProxyAgent
      ? new undiciHandles.ProxyAgent(this.proxyUrl)
      : null;
  }

  getFetch() {
    if (this.dispatcher && this.undiciFetch) {
      return this.undiciFetch;
    }
    if (this.undiciFetch) {
      return this.undiciFetch;
    }
    return typeof fetch === "function" ? fetch : null;
  }

  isReady() {
    const fetchFn = this.getFetch();
    const ready = this.enabled && this.baseUrl && this.apiKey && this.model && Boolean(fetchFn);
    if (!ready && this.verbose) {
      console.warn("[promise-classifier] not ready:", {
        enabled: this.enabled,
        baseUrl: Boolean(this.baseUrl),
        apiKey: Boolean(this.apiKey),
        model: this.model || "(empty)",
        fetch: Boolean(fetchFn),
      });
    }
    return ready;
  }

  async classify({ text = "", promisor = "assistant", dueType = "" } = {}) {
    if (!this.isReady()) {
      return null;
    }
    const normalized = String(text || "").trim();
    if (!normalized) {
      return null;
    }
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const userPrompt = buildUserPrompt({ text: normalized, promisor, dueType });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.verbose) {
        console.warn(`[promise-classifier] -> ${this.model} @ ${endpoint} proxy=${this.proxyUrl || "(none)"} text="${truncate(normalized, 60)}"`);
      }
      const fetchOptions = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        }),
      };
      if (this.dispatcher) {
        fetchOptions.dispatcher = this.dispatcher;
      }
      const fetchFn = this.getFetch();
      const response = await fetchFn(endpoint, fetchOptions);
      if (!response.ok) {
        if (this.verbose) {
          const body = await response.text().catch(() => "");
          console.warn(`[promise-classifier] HTTP ${response.status}: ${truncate(body, 200)}`);
        }
        return null;
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content || "";
      const verdict = parseClassifierOutput(content);
      if (this.verbose) {
        console.warn(`[promise-classifier] verdict=${JSON.stringify(verdict)} raw="${truncate(content, 200)}"`);
      }
      return verdict;
    } catch (error) {
      if (this.verbose) {
        const causeMessage = error?.cause?.message || error?.cause?.code || "";
        const causeStack = error?.cause?.stack ? `\n${error.cause.stack.split("\n").slice(0, 3).join("\n")}` : "";
        console.warn(`[promise-classifier] error: ${error?.message || error}${causeMessage ? ` | cause: ${causeMessage}` : ""}${causeStack}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUserPrompt({ text, promisor, dueType }) {
  const speakerLabel = promisor === "user" ? "苏苏（用户）" : "阿星（AI）";
  const hint = dueType ? `（类型：${dueType}）` : "";
  return [
    `说话人：${speakerLabel}${hint}`,
    "原文：",
    text,
    "",
    "请判断这句话是否构成一个会被对方回头核对的承诺/约定。",
    "严格只输出 JSON。",
  ].join("\n");
}

function truncate(text, max) {
  const value = String(text || "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function loadUndici() {
  try {
    const mod = require("undici");
    return { fetch: mod.fetch || null, ProxyAgent: mod.ProxyAgent || null };
  } catch (error) {
    return { fetch: null, ProxyAgent: null };
  }
}

function parseClassifierOutput(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }
  const jsonText = extractJsonBlock(text);
  if (!jsonText) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      isPromise: parsed.is_promise === true,
      confidence: clamp(Number(parsed.confidence), 0, 1),
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    };
  } catch {
    return null;
  }
}

function extractJsonBlock(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return "";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  PromiseClassifier,
  parseClassifierOutput,
};
