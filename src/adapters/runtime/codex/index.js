function createCodexRuntimeAdapter() {
  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

