function filterOutgoingMessage(draft) {
  if (!draft) return draft;

  // 禁止记忆系统内部信息泄露到微信
  const forbidden = [
    'memory', 'index.jsonl', 'simple-memory-service', 
    'embedding', 'cosineSimilarity', 'mem_', 'pending.jsonl'
  ];

  let cleaned = draft;
  for (const word of forbidden) {
    const regex = new RegExp(word, 'gi');
    cleaned = cleaned.replace(regex, '[已过滤]');
  }

  return cleaned;
}

module.exports = { filterOutgoingMessage };