# Agent 岗位地图

## 先看结论

“Agent 岗”不是一种统一岗位。常见的其实有三类：

| 类型 | 日常主要做什么 | 你当前的匹配度 |
|---|---|---:|
| Agent 应用工程 | 接模型、设计工具、编排任务、管理上下文、做业务 API 和故障处理 | 高 |
| 后端 + AI | 建 REST API、存储和异步任务，同时接入 RAG/Agent 能力 | 高 |
| Agent 算法研究 | 训练/微调、强化学习、多智能体算法、规划与评测研究 | 暂时较低 |

你的主目标应是前两类。

## Agent 应用工程师每天可能做什么

### 1. 把真实输入送进模型

输入不一定来自网页聊天框，还可能来自：

- IM 消息；
- HTTP API；
- 文件和图片；
- 定时任务；
- 数据库状态变化；
- 其他系统发出的事件。

工程师需要完成格式标准化、身份识别、会话绑定和错误处理。

Cyberboss 对应：微信 / Telegram 入站消息、System Message、Reminder 和定位事件。

### 2. 让模型不只“说话”，还能够行动

常见行动包括：

- 查询数据库或知识库；
- 调用业务 API；
- 创建提醒和任务；
- 读写文件；
- 生成报告；
- 调用其他服务。

工程师需要设计工具名称、参数 Schema、权限、超时、错误返回和调用日志。

Cyberboss 对应：28 个结构化项目工具以及 MCP Tool Host。

### 3. 管理一次任务的上下文和状态

需要回答：

- 这条消息属于哪个用户？
- 应该复用哪条会话？
- 当前任务是否仍在执行？
- 新消息应该插队、合并还是等待？
- 模型的回复应发送到哪个通道？

Cyberboss 对应：identity、binding、workspace、thread、turn、Turn Gate 和 Reply Target。

### 4. 处理“模型会失败”这件事

真实 Agent 会遇到：

- 模型连接中断；
- 输出到一半失败；
- 工具参数不合法；
- 工具成功但回复没有送达；
- 上下文过长；
- 多个事件同时争用同一线程。

所以岗位通常也看重测试、日志、重试、可观测性和故障排查。

### 5. 判断 Agent 是否真的有用

算法岗可能关注成功率、推理能力和评测集；应用岗还会关注：

- 用户任务是否完成；
- 响应是否太慢；
- 调用成本是否合理；
- 工具是否误调用；
- 出错后能否恢复；
- 产品是否真的解决了用户问题。

## JD 中的关键词怎么翻译

| JD 写法 | 实际要会什么 |
|---|---|
| Agent 全链路开发 | 输入 → 会话 → 模型 → 工具 → 输出 → 评测 |
| Tool Calling / Function Calling | 定义结构化工具，让模型按 Schema 传参 |
| Memory / Context Engineering | 决定存什么、何时检索、怎样注入上下文 |
| Agent Framework | 理解框架替你处理了哪些循环、状态和工具协议 |
| RAG | 检索、召回、重排、上下文拼装和答案约束 |
| Workflow / Orchestration | 多步骤任务如何排序、分支、重试和恢复 |
| Evaluation | 用案例和指标判断 Agent 是否完成任务 |
| High Availability | 服务失败、重启、扩容时如何尽量不中断 |
| Prompt Engineering | 把目标、约束、工具和输出格式说清楚并验证 |

## 哪些是必须补的基础

优先补：

- 一门主语言：Java 或 Python；Node.js 项目至少要能读懂；
- HTTP、REST API、JSON；
- 数据库、索引和事务的基础；
- 进程、线程、异步 I/O 的基本概念；
- 队列、重试、幂等；
- Git、Linux、日志和测试；
- LLM 基础、Prompt、Tool Calling、RAG。

知道概念即可，暂时不深挖：

- 多智能体协作框架；
- 模型微调；
- 强化学习；
- 分布式训练；
- 向量数据库底层索引算法；
- Agent 学术论文谱系。

## 当前岗位样本给出的信号

近期岗位中，Agent 应用方向反复出现的是 Python 工程、LLM 应用、RAG、工具调用、记忆、任务闭环、评测与系统落地；普通后端岗位则继续强调数据结构、操作系统、网络、数据库、可靠性和可维护代码。

参考岗位：

- [百度：秒哒大模型算法实习生](https://talent.baidu.com/jobs/detail/INTERN/320200cd-893d-4076-b39d-1f77f7a79948)
- [百度：Agent 算法实习生](https://talent.baidu.com/jobs/detail/INTERN/cd423c1c-7a35-4672-b0a7-2857308efe43)
- [百度：Python/Go 开发实习生](https://talent.baidu.com/jobs/detail/INTERN/8e63ffa4-bd89-4275-a951-b9c6e9e647d4)
- [GeoComply：Software Engineer Intern (Backend)](https://jobs.lever.co/geocomply-2/b98890bb-ce91-4535-830c-085fd915bfb0)

这些样本只用来提取共性。最终简历仍应依据你实际想投的 3～5 个 JD 调整。

