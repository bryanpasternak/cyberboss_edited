const fs = require('fs');
const path = require('path');
const { pipeline } = require('@huggingface/transformers');

// ==================== 配置 ====================
const MEMORY_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.cyberboss', 'memory');
const INDEX_PATH = path.join(MEMORY_DIR, 'index.jsonl');
const OPS_LOG = path.join(MEMORY_DIR, 'ops.log');

console.log(`[Memory] 记忆系统初始化，目录: ${MEMORY_DIR}`);

// ==================== 工具函数 ====================
function logOperation(op, details) {
  const entry = `[${new Date().toISOString()}] ${op} | ${details}\n`;
  fs.appendFileSync(OPS_LOG, entry);
  console.log(`[Memory] ${op} - ${details}`);
}

function appendToMarkdown(category, key, text) {
  const mdPath = path.join(MEMORY_DIR, `${category}.md`);
  const content = `\n### ${key} (${new Date().toLocaleString('zh-CN')})\n${text}\n`;
  fs.appendFileSync(mdPath, content);
}

// ==================== Embedding ====================
let embedder = null;

async function getEmbedder() {
  if (!embedder) {
    console.log('[Memory] 首次加载 embedding 模型（约80MB）...');
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('[Memory] embedding 模型加载完成');
  }
  return embedder;
}

// ==================== 主服务类 ====================
class SimpleMemoryService {
  constructor() {
    this.ensureIndexExists();
  }

  ensureIndexExists() {
    if (!fs.existsSync(INDEX_PATH)) {
      fs.writeFileSync(INDEX_PATH, '');
      logOperation('INIT', '创建 index.jsonl');
    }
  }

  /** 添加一条记忆
   * speaker: 'user'(苏苏说的) | 'self'(阿星说的/观察) | 'fact'(客观关系事实) | 'observation'(规则/总结)
   */
  async addMemory({ category, key, value, text, priority = 'medium', source = 'chat', speaker = 'fact' }) {
    const entry = {
      id: `mem_${new Date().toISOString().replace(/[:.T-]/g, '').slice(0, 14)}`,
      category,
      key,
      value: value !== undefined ? value : true,
      priority,
      scope: 'user',
      source,
      speaker,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      text: text || `${key}: ${value}`
    };

    // 写入 index.jsonl
    fs.appendFileSync(INDEX_PATH, JSON.stringify(entry) + '\n');

    // 写入 markdown（给人看）
    appendToMarkdown(category, key, text || entry.text);

    logOperation('ADD', `${category}/${key} | ${text?.slice(0, 50)}...`);
    return entry.id;
  }

  /** 语义搜索记忆（解决记反和长期锚点） */
  async searchMemory(query, limit = 6) {
    try {
      const embedder = await getEmbedder();
      const queryEmb = await embedder(query, { pooling: 'mean', normalize: true });

      const lines = fs.readFileSync(INDEX_PATH, 'utf8').split('\n').filter(Boolean);
      const results = [];

      for (const line of lines) {
        try {
          const mem = JSON.parse(line);
          if (mem.status !== 'active') continue;

          const memEmb = await embedder(mem.text, { pooling: 'mean', normalize: true });
          const similarity = this.cosineSimilarity(queryEmb.data, memEmb.data);

          if (similarity > 0.65) {  // 阈值可调
            results.push({ ...mem, similarity });
          }
        } catch (e) {}
      }

      const sorted = results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
      logOperation('SEARCH', `查询"${query.slice(0,30)}..." 找到 ${sorted.length} 条`);
      return sorted;
    } catch (err) {
      console.error('[Memory] 搜索失败:', err.message);
      return [];
    }
  }

  cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1);
  }

  /** 获取关系锚点（专门解决感情浓度） */
  async getRelationshipAnchor() {
    const anchors = await this.searchMemory("我们的关系、感情、相处模式、里程碑", 4);
    return anchors.map(m => m.text).join('\n');
  }

  /** 读取所有活跃记忆（调试用） */
  getAllActiveMemories() {
    try {
      const lines = fs.readFileSync(INDEX_PATH, 'utf8').split('\n').filter(Boolean);
      return lines.map(line => JSON.parse(line)).filter(m => m.status === 'active');
    } catch (e) {
      return [];
    }
  }
}

const memoryService = new SimpleMemoryService();
module.exports = memoryService;