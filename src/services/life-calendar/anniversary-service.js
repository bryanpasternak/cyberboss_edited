const crypto = require("crypto");
const { assertDateString, daysBetween } = require("./date-utils");

class AnniversaryService {
  constructor({ store, today = () => new Date().toISOString().slice(0, 10), now = () => new Date() }) {
    this.store = store;
    this.today = today;
    this.now = now;
  }

  create(input = {}) {
    const now = this.now().toISOString();
    const item = normalizeAnniversary({ ...input, id: input.id || crypto.randomUUID(), createdAt: now, updatedAt: now });
    const items = this.store.read();
    if (items.some((candidate) => candidate.id === item.id)) throw new Error(`Anniversary already exists: ${item.id}`);
    this.store.write([...items, item]);
    return item;
  }

  list() { return this.store.read(); }

  get(id) {
    const item = this.store.read().find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Anniversary not found: ${id}`);
    return item;
  }

  update(id, patch = {}) {
    const items = this.store.read();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`Anniversary not found: ${id}`);
    items[index] = normalizeAnniversary({ ...items[index], ...patch, id, updatedAt: this.now().toISOString() });
    this.store.write(items);
    return items[index];
  }

  delete(id) {
    const items = this.store.read();
    const next = items.filter((candidate) => candidate.id !== id);
    if (next.length === items.length) throw new Error(`Anniversary not found: ${id}`);
    this.store.write(next);
    return { id, deleted: true };
  }

  getCount(id, { asOfDate = this.today() } = {}) {
    const item = this.get(id);
    const asOf = assertDateString(asOfDate, "asOfDate");
    const elapsed = daysBetween(item.startDate, asOf);
    const daysSince = elapsed + (item.countingRule === "inclusive" ? 1 : 0);
    const nextOccurrence = resolveNextOccurrence(item.startDate, asOf);
    return { anniversary: item, asOfDate: asOf, daysSince, nextOccurrence, daysUntilNext: daysBetween(asOf, nextOccurrence) };
  }

  listForDate(date) {
    const normalized = assertDateString(date);
    return this.store.read().filter((item) => item.repeat === "yearly"
      ? item.startDate.slice(5) === normalized.slice(5)
      : item.startDate === normalized);
  }
}

function normalizeAnniversary(input) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Anniversary name cannot be empty.");
  const countingRule = input.countingRule || "inclusive";
  const repeat = input.repeat || "yearly";
  if (!["inclusive", "exclusive"].includes(countingRule)) throw new Error("Anniversary countingRule is invalid.");
  if (!["yearly", "none"].includes(repeat)) throw new Error("Anniversary repeat is invalid.");
  return {
    id: String(input.id),
    name,
    startDate: assertDateString(input.startDate, "startDate"),
    calendar: "gregorian",
    countingRule,
    repeat,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function resolveNextOccurrence(startDate, asOfDate) {
  const suffix = startDate.slice(4);
  let candidate = `${asOfDate.slice(0, 4)}${suffix}`;
  if (candidate < asOfDate) candidate = `${Number(asOfDate.slice(0, 4)) + 1}${suffix}`;
  return candidate;
}

module.exports = { AnniversaryService, resolveNextOccurrence };
