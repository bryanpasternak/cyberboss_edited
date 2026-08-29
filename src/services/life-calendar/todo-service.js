const crypto = require("crypto");
const { assertDateString, instantDateInTimezone, normalizeInstant } = require("./date-utils");

class TodoService {
  constructor({ store, now = () => new Date(), timezone = "Asia/Shanghai" }) {
    this.store = store;
    this.now = now;
    this.timezone = timezone;
  }

  create(input = {}) {
    const now = this.now().toISOString();
    const item = normalizeTodo({ ...input, id: input.id || crypto.randomUUID(), createdAt: now, updatedAt: now });
    const items = this.store.read();
    if (items.some((candidate) => candidate.id === item.id)) throw new Error(`Todo already exists: ${item.id}`);
    this.store.write([...items, item]);
    return item;
  }

  list(filters = {}) {
    return this.store.read().filter((item) => {
      if (filters.status && item.status !== filters.status) return false;
      if (filters.assignee && item.assignee !== filters.assignee) return false;
      if (filters.date && !todoTouchesDate(item, assertDateString(filters.date), this.timezone)) return false;
      return true;
    });
  }

  get(id) {
    const item = this.store.read().find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Todo not found: ${id}`);
    return item;
  }

  update(id, patch = {}) {
    const items = this.store.read();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Todo not found: ${id}`);
    items[index] = normalizeTodo({ ...items[index], ...patch, id, updatedAt: this.now().toISOString() });
    this.store.write(items);
    return items[index];
  }

  complete(id) {
    return this.update(id, { status: "completed", completedAt: this.now().toISOString() });
  }

  reopen(id) {
    return this.update(id, { status: "pending", completedAt: null });
  }

  delete(id) {
    const items = this.store.read();
    const next = items.filter((candidate) => candidate.id !== id);
    if (next.length === items.length) throw new Error(`Todo not found: ${id}`);
    this.store.write(next);
    return { id, deleted: true };
  }
}

function normalizeTodo(input) {
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Todo title cannot be empty.");
  const status = input.status || "pending";
  if (!["pending", "completed", "cancelled"].includes(status)) throw new Error("Todo status is invalid.");
  return {
    id: String(input.id),
    title,
    description: String(input.description || "").trim(),
    status,
    assignee: String(input.assignee || "shared").trim() || "shared",
    scheduledDate: input.scheduledDate ? assertDateString(input.scheduledDate, "scheduledDate") : null,
    dueAt: normalizeInstant(input.dueAt, "dueAt"),
    completedAt: normalizeInstant(input.completedAt, "completedAt"),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function todoTouchesDate(item, date, timezone = "Asia/Shanghai") {
  return item.scheduledDate === date || (item.dueAt && instantDateInTimezone(item.dueAt, timezone) === date);
}

module.exports = { TodoService, todoTouchesDate };
