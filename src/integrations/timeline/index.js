function createTimelineIntegration(config) {
  return {
    describe() {
      return {
        id: "timeline-for-agent",
        kind: "integration",
        command: config.timelineCommand,
      };
    },
  };
}

module.exports = { createTimelineIntegration };
