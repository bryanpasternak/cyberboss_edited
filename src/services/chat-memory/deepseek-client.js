class DeepSeekClient {
  constructor({ config = {} } = {}) {
    this.enabled = Boolean(config.chatMemoryDeepSeekEnabled);
    this.baseUrl = normalizeText(config.chatMemoryDeepSeekBaseUrl) || "https://api.deepseek.com/v1";
    this.apiKey = normalizeText(config.chatMemoryDeepSeekApiKey);
    this.model = normalizeText(config.chatMemoryDeepSeekModel) || "deepseek-chat";
    this.timeoutMs = Math.max(1000, Number(config.chatMemoryDeepSeekTimeoutMs) || 30000);
    this.proxyUrl = normalizeText(config.chatMemoryDeepSeekProxy)
      || normalizeText(process.env.HTTPS_PROXY)
      || normalizeText(process.env.https_proxy)
      || normalizeText(process.env.HTTP_PROXY)
      || normalizeText(process.env.http_proxy)
      || normalizeText(process.env.ALL_PROXY)
      || normalizeText(process.env.all_proxy);
    this.verbose = Boolean(config.chatMemoryDeepSeekVerbose);

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
      console.warn("[deepseek-client] not ready:", {
        enabled: this.enabled,
        baseUrl: Boolean(this.baseUrl),
        apiKey: Boolean(this.apiKey),
        model: this.model || "(empty)",
        fetch: Boolean(fetchFn),
      });
    }
    return ready;
  }

  /**
   * 通用 chat/completions 调用。
   * @param {Object} params
   * @param {Array<{role:string,content:string}>} params.messages
   * @param {number} [params.temperature=0.3]
   * @param {number} [params.maxTokens=4096]
   * @param {boolean} [params.jsonMode=false] - 是否启用 JSON mode (response_format)
   * @returns {Promise<string|null>} 返回 message content 或 null
   */
  async chatCompletion({
    messages = [],
    temperature = 0.3,
    maxTokens = 4096,
    jsonMode = false,
  } = {}) {
    if (!this.isReady()) {
      return null;
    }
    if (!Array.isArray(messages) || !messages.length) {
      return null;
    }

    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = {
        model: this.model,
        temperature,
        max_tokens: maxTokens,
        messages,
      };
      if (jsonMode) {
        body.response_format = { type: "json_object" };
      }

      if (this.verbose) {
        console.warn(
          `[deepseek-client] -> ${this.model} @ ${endpoint} proxy=${this.proxyUrl || "(none)"} jsonMode=${jsonMode}`
        );
      }

      const fetchOptions = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      };
      if (this.dispatcher) {
        fetchOptions.dispatcher = this.dispatcher;
      }

      const fetchFn = this.getFetch();
      const response = await fetchFn(endpoint, fetchOptions);

      if (!response.ok) {
        if (this.verbose) {
          const errorBody = await response.text().catch(() => "");
          console.warn(`[deepseek-client] HTTP ${response.status}: ${truncate(errorBody, 300)}`);
        }
        return null;
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content || "";

      if (this.verbose) {
        console.warn(`[deepseek-client] response ${content.length} chars`);
      }

      return content;
    } catch (error) {
      if (this.verbose) {
        const causeMsg = error?.cause?.message || error?.cause?.code || "";
        console.warn(
          `[deepseek-client] error: ${error?.message || error}${causeMsg ? ` | cause: ${causeMsg}` : ""}`
        );
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 便捷方法：发送 system + user prompt，返回解析后的 JSON 对象。
   * 如果 API 调用失败或 JSON 解析失败，返回 null。
   *
   * @param {Object} params
   * @param {string} params.systemPrompt
   * @param {string} params.userContent
   * @param {number} [params.maxTokens=4096]
   * @param {number} [params.temperature=0.3]
   * @returns {Promise<Object|null>}
   */
  async structuredPrompt({
    systemPrompt = "",
    userContent = "",
    maxTokens = 4096,
    temperature = 0.3,
  } = {}) {
    const content = await this.chatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature,
      maxTokens,
      jsonMode: true,
    });

    if (!content) {
      return null;
    }

    return parseJsonContent(content);
  }
}

/**
 * 从 LLM 返回的文本中提取并解析 JSON。
 * 处理可能被 markdown 代码块包裹的情况。
 */
function parseJsonContent(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return null;
  }

  // 优先尝试直接解析
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // 继续尝试其他方式
  }

  // 去掉 markdown 代码块包裹
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // 继续尝试提取花括号内容
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // 彻底失败
    }
  }

  return null;
}

function loadUndici() {
  try {
    const mod = require("undici");
    return { fetch: mod.fetch || null, ProxyAgent: mod.ProxyAgent || null };
  } catch {
    return { fetch: null, ProxyAgent: null };
  }
}

function truncate(text, max) {
  const value = String(text || "");
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { DeepSeekClient };
