const memoryService = require('../services/simple-memory-service');

async function handleMemoryCommand(msg) {
  const text = (msg.text || '').trim();
  
  // 支持 \memory 和 /memory 两种前缀
  if (!text.startsWith('\\memory') && !text.startsWith('/memory')) {
    return null;
  }

  console.log(`[Memory Command] 收到: ${text}`);

  const command = text.replace(/^\\memory\s*|^\/memory\s*/, '').trim();

  if (command === '' || command === 'show') {
    const all = memoryService.getAllActiveMemories();
    return `✅ 当前活跃记忆总数: ${all.length} 条\n\n` + 
           all.slice(0, 15).map((m, i) => `${i+1}. [${m.category}] ${m.key}`).join('\n');
  }

  if (command.startsWith('search ')) {
    const query = command.replace('search ', '');
    const results = await memoryService.searchMemory(query, 6);
    if (results.length === 0) return '🔍 没有找到相关记忆。';
    return results.map(r => 
      `【${r.category}】${r.text}\n(相似度: ${r.similarity.toFixed(2)})`
    ).join('\n\n');
  }

  if (command === 'relationships' || command === '关系') {
    const anchor = await memoryService.getRelationshipAnchor();
    return `❤️ 【关系与感情锚点】\n${anchor || '暂无长期关系记忆'}`;
  }

  if (command === 'help') {
    return `可用命令：\n` +
           `\\memory show          查看所有记忆\n` +
           `\\memory search 关键词   搜索记忆\n` +
           `\\memory relationships   查看关系锚点\n` +
           `\\memory help            显示帮助`;
  }

  return '未知 memory 命令。输入 \\memory help 查看帮助。';
}

module.exports = { handleMemoryCommand };