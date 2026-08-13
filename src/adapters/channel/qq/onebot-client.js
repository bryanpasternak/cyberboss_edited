const crypto = require("crypto");
const WebSocket = require("ws");

const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

class OneBotClient {
  constructor({
    url,
    accessToken = "",
    selfId = "",
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
    WebSocketImpl = WebSocket,
  } = {}) {
    this.url = normalizeText(url);
    this.accessToken = normalizeText(accessToken);
    this.selfId = normalizeText(selfId);
    this.actionTimeoutMs = Math.max(1_000, Number(actionTimeoutMs) || DEFAULT_ACTION_TIMEOUT_MS);
    this.reconnectDelaysMs = Array.isArray(reconnectDelaysMs) && reconnectDelaysMs.length
      ? reconnectDelaysMs.map(Number).filter((value) => Number.isFinite(value) && value >= 0)
      : DEFAULT_RECONNECT_DELAYS_MS;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.events = [];
    this.eventWaiters = [];
    this.pendingActions = new Map();
  }

  async connect() {
    if (!this.url) {
      throw new Error("OneBot WebSocket URL is missing");
    }
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.closedByUser = false;
    this.clearReconnectTimer();
    this.connectPromise = new Promise((resolve, reject) => {
      const headers = {};
      if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
      if (this.selfId) headers["X-Self-ID"] = this.selfId;
      const socket = new this.WebSocketImpl(this.url, { headers });
      this.socket = socket;
      let settled = false;

      const rejectConnection = (error) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error || "OneBot connection failed")));
      };

      socket.once("open", () => {
        settled = true;
        this.reconnectAttempt = 0;
        resolve();
      });
      socket.on("message", (data) => this.handleMessage(data));
      socket.once("error", rejectConnection);
      socket.once("close", () => {
        if (!settled) rejectConnection(new Error("OneBot connection closed before opening"));
        if (this.socket === socket) this.socket = null;
        this.rejectPendingActions(new Error("OneBot connection closed"));
        this.rejectEventWaiters(new Error("OneBot connection closed"));
        if (!this.closedByUser) this.scheduleReconnect();
      });
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async callAction(action, params = {}) {
    await this.connect();
    if (!this.socket || this.socket.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("OneBot WebSocket is not connected");
    }
    const echo = `cyberboss-${crypto.randomUUID()}`;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OneBot action timed out: ${action}`));
      }, this.actionTimeoutMs);
      this.pendingActions.set(echo, { action, resolve, reject, timer });
    });
    try {
      this.socket.send(JSON.stringify({ action, params, echo }));
    } catch (error) {
      this.settlePendingAction(echo, error, null);
    }
    return result;
  }

  async getEvents({ timeoutMs = 30_000 } = {}) {
    await this.connect();
    if (this.events.length) return this.drainEvents();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.eventWaiters.indexOf(waiter);
        if (index >= 0) this.eventWaiters.splice(index, 1);
        resolve([]);
      }, Math.max(1, Number(timeoutMs) || 30_000));
      this.eventWaiters.push(waiter);
    });
  }

  handleMessage(data) {
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch {
      return;
    }
    const echo = normalizeText(payload?.echo);
    if (echo && this.pendingActions.has(echo)) {
      const ok = payload?.status === "ok" && Number(payload?.retcode || 0) === 0;
      const error = ok ? null : new Error(
        `OneBot action failed: ${payload?.message || payload?.wording || payload?.retcode || "unknown error"}`
      );
      this.settlePendingAction(echo, error, payload?.data);
      return;
    }
    if (payload?.post_type) this.enqueueEvent(payload);
  }

  enqueueEvent(event) {
    this.events.push(event);
    const waiters = this.eventWaiters.splice(0);
    if (!waiters.length) return;
    const events = this.drainEvents();
    waiters.forEach((waiter, index) => {
      clearTimeout(waiter.timer);
      waiter.resolve(index === 0 ? events : []);
    });
  }

  drainEvents() {
    return this.events.splice(0);
  }

  settlePendingAction(echo, error, data) {
    const pending = this.pendingActions.get(echo);
    if (!pending) return;
    this.pendingActions.delete(echo);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(data);
  }

  rejectPendingActions(error) {
    for (const echo of [...this.pendingActions.keys()]) {
      this.settlePendingAction(echo, error, null);
    }
  }

  rejectEventWaiters(error) {
    const waiters = this.eventWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const index = Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1);
    const delay = this.reconnectDelaysMs[index] || 0;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
  }

  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  close() {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.rejectPendingActions(new Error("OneBot client closed"));
    this.rejectEventWaiters(new Error("OneBot client closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === this.WebSocketImpl.OPEN || socket.readyState === this.WebSocketImpl.CONNECTING)) {
      socket.close();
    }
  }
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).trim();
}

module.exports = {
  OneBotClient,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_RECONNECT_DELAYS_MS,
};
