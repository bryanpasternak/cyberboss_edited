# Cyberboss 岗位匹配与简历短版

## 一句话判断

Cyberboss 最适合证明的不是“我会使用聊天机器人”，而是：

> 我做过一个有真实输入通道、会话状态、结构化工具、异步事件和故障边界的 Agent 应用。

## 项目与岗位要求的对应关系

| 岗位能力 | Cyberboss 中的事实 | 面试价值 |
|---|---|---:|
| 后端模块化设计 | Channel / Runtime / Capability 分层 | 高 |
| API 与外部系统接入 | 微信、Telegram、Codex、Claude Code | 高 |
| 会话与状态管理 | identity、binding、workspace、thread、turn | 高 |
| Agent Tool Calling | 28 个 JSON Schema 项目工具、MCP stdio | 高 |
| 异步任务 | Reminder、System Message、Timeline Screenshot 队列 | 高 |
| 并发与顺序 | Turn Gate、Pending Buffer、Reply Target | 高 |
| Agent 权限设计 | 共读模块只允许访问已读文本 | 高、辨识度强 |
| 测试与排错 | 20 个测试文件、172 个静态测试定义 | 中 |
| RAG | Cyberboss 不是主要证据，由医疗 RAG 项目承担 | 另一个项目负责 |
| 数据库与缓存 | 主系统以本地 JSON 为主 | 当前短板 |
| 部署与可观测性 | 有本地日志、状态检查和共享进程入口 | 需要继续补 |

## 可以直接放进简历的短版

**Cyberboss｜本地多通道主动式 AI Agent Bridge**  
**2026.04—至今**

面向 ADHD 外部监督与长期陪伴场景，将微信、Telegram 等通信渠道接入本地 Agent Runtime，使 Agent 能持续处理用户消息、调用工具，并通过提醒与随机唤醒机制主动参与用户日程。

**技术栈：** Node.js、HTTP Long Polling、WebSocket、MCP、JSON Schema、Codex、Claude Code、node:test

- 按 Channel Adapter、Runtime Adapter 和 Capability Layer 拆分系统，将微信、Telegram 消息统一路由至 Codex / Claude Code，并依据 Runtime 事件将流式回复返回原会话。
- 设计 Reminder 与随机 Check-in 等主动任务链路，通过本地持久化队列、Turn Gate 和 Pending Buffer 协调用户消息与系统任务，避免多个 Turn 争用同一会话。
- 将提醒、日记、时间轴、文件、记忆和定位等能力封装为 28 个结构化项目工具，通过 MCP 向 Agent 暴露，并完成参数校验与运行上下文解析。
- 推动人机共读模块落地，通过阅读心跳、停留判定和已读区间门禁，仅向 Agent 开放用户已经阅读的文本，并支持双向批注与回复。

## 为什么这四条值得保留

### 第一条：证明你能理解完整后端调用链

不是“调用一次大模型 API”，而是：

```text
通信通道 → 消息标准化 → 会话绑定 → Runtime → 事件流 → 原通道回复
```

### 第二条：证明你理解 Agent 不只有用户请求

Agent 还要处理定时任务、系统事件、任务冲突和执行顺序。

### 第三条：证明模型能够调用真实能力

重点不在“28”这个数字本身，而在你能讲清工具的 Schema、Service、Context 和错误边界。

### 第四条：证明你做过产品化约束

防剧透不是一句 Prompt，而是后端拒绝向 Agent 返回未读文本。这是 Cyberboss 最有个人辨识度的一点。

## 需要避免的写法

不要写：

- 高并发架构；
- 分布式任务调度；
- 生产级高可用；
- 显著提升效率；
- 主导底层 Agent 算法；
- 精通 MCP；
- 172 个测试全部通过。

原因：

- 当前主要是本地单用户系统；
- 队列基于 JSON 文件，不是分布式消息中间件；
- 本轮只静态统计了测试，没有执行；
- 项目体现的是 Agent 应用工程，不是模型训练算法。

## AI 辅助开发如何表达

推荐说法：

> 项目大量使用 AI 协同开发。我负责提出场景和需求、选择方案、拆分验收标准，并通过运行结果和源码定位推动迭代。为了能对简历负责，我正在按核心调用链重新补齐底层实现。

不要把贡献缩成“代码不是我写的”，也不要反过来声称自己逐行独立完成。需求定义、方案判断、调试、验收和迭代本来就是工程工作。

## 代码证据入口

- [核心架构](../architecture.md)
- [主编排器](../../src/core/app.js)
- [流式回复](../../src/core/stream-delivery.js)
- [项目工具](../../src/tools/tool-host.js)
- [随机 Check-in](../../src/app/system-checkin-poller.js)
- [共读架构](../../read-along/docs/ARCHITECTURE.md)
- [测试目录](../../test)

