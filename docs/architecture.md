# Architecture

## Core

`core` 负责：

- 读取配置
- 选择要使用的 channel / runtime / integrations
- 编排能力，而不是实现具体协议

## Channel Adapters

`adapters/channel/*`

负责：

- 收消息
- 发消息
- typing / 媒体 / 上下文 token

不负责：

- Codex / Claude Code 线程
- reminder / timeline / diary 逻辑

## Runtime Adapters

`adapters/runtime/*`

负责：

- 把消息送进具体 agent runtime
- 处理 thread / session / approval / stop

不负责：

- 微信协议
- timeline 页面

## Capability Integrations

`integrations/*`

例如：

- `timeline`
- `reminder`
- `diary`

这些能力应该尽量依赖外部独立项目，而不是重新把实现揉回主仓库。

## 当前预期依赖

- timeline:
  - `timeline-for-agent`
- weixin bridge:
  - 待拆分成独立 adapter
- codex runtime:
  - 待拆分成独立 adapter

