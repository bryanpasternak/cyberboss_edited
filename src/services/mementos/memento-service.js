class MementoService {
  constructor({ store, typeServices }) { this.store = store; this.typeServices = typeServices; }

  list({ type = "", status = "", viewerId = "" } = {}) {
    return this.store.list({ type, status }).map((record) => this.view(record, viewerId));
  }

  read({ id, viewerId = "" } = {}) {
    return this.view(this.store.read(id), viewerId);
  }

  view(record, viewerId) {
    const service = this.typeServices[record.type];
    if (!service) throw new Error(`No service for memento type ${record.type}`);
    return service.getView(record, viewerId);
  }
}

module.exports = { MementoService };
