class OverviewService {
  constructor({ calendar, todos, anniversaries }) {
    this.calendar = calendar;
    this.todos = todos;
    this.anniversaries = anniversaries;
  }

  getDay(date) {
    const calendar = this.calendar.getDay(date);
    const anniversaryItems = this.anniversaries.listForDate(calendar.date)
      .map((item) => this.anniversaries.getCount(item.id, { asOfDate: calendar.date }));
    return {
      date: calendar.date,
      calendar,
      todos: this.todos.list({ date: calendar.date }),
      anniversaries: anniversaryItems,
    };
  }
}

module.exports = { OverviewService };
