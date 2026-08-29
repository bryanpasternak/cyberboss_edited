# 生活日历后端实现计划

## 1. 目标与一期范围

一期建立可由 Cyberboss 后端和 MCP 共同复用的生活时间基础能力，不建设前端，也不做自动上下文注入。

本期包含：

- 日历：日期、星期、周末、法定放假、调休工作日、常用公历与农历节日。
- 待办：创建、查询、修改、完成和删除；日期字段可选。
- 纪念日：创建、查询、修改、删除、相隔天数与下一次周年计算。
- 日概览：按日期聚合日历信息、相关待办和纪念日。
- MCP 预留：业务逻辑不写入 MCP handler，后续只增加薄适配层。

不在一期实现：前端、提醒推送、自动注入、远程节假日定时同步、经期/运动/饮食、完整时间线、多人权限。

## 2. 模块边界

```text
life-calendar/
├─ calendar-service        日期与日历查询
├─ holiday-provider       官方休班数据
├─ festival-provider      公历/农历节日规则
├─ todo-service           待办业务
├─ anniversary-service    纪念日业务
├─ overview-service       只读聚合
└─ json-store             一期本地持久化
```

模块共享服务层，但各自保留数据所有权。`overview` 只在查询时组合结果，不复制数据。

## 3. 数据来源

### 法定放假与调休

- 上游：`NateScarlet/holiday-cn` 年度 JSON。
- 权威依据：JSON 中 `papers` 指向国务院办公厅年度安排通知。
- 运行方式：同步后保存至 `data/calendar/holidays/CN/<year>.json`，运行时只读本地文件。
- 缺少年度数据时：普通日期仍可判断星期和周末，但返回 `holidayDataAvailable: false`，不猜测调休。

后续增加 `holiday sync --year <year>`，负责下载、校验、原子替换；网络数据不能直接进入在线查询路径。

### 节日

- 固定公历节日使用本地规则，如 2 月 14 日情人节。
- 农历节日使用 Node.js `Intl` 的中国农历转换能力匹配规则，如农历七月初七七夕、八月十五中秋。
- 展示节日与是否放假是两个独立概念。

## 4. 时间约定

- 默认业务时区：`Asia/Shanghai`。
- 纯日期统一为严格的 `YYYY-MM-DD`。
- 具体时刻保存 ISO 8601；持久化前规范化为 UTC ISO 字符串。
- 日期范围采用闭区间，接口返回值明确 `from` 与 `to`。
- 纪念日天数默认首日计为第 1 天（`inclusive`），也支持首日为第 0 天（`exclusive`）。

## 5. 一期服务接口

### CalendarService

- `getToday()`
- `getDay(date)`
- `getRange({ from, to })`
- `getMonth({ year, month })`

### TodoService

- `create(input)`
- `list(filters)`
- `get(id)`
- `update(id, patch)`
- `complete(id)` / `reopen(id)`
- `delete(id)`

### AnniversaryService

- `create(input)`
- `list()` / `get(id)`
- `update(id, patch)` / `delete(id)`
- `getCount(id, { asOfDate })`
- `listForDate(date)`

### OverviewService

- `getDay(date)`

## 6. 后续 MCP 工具

第一轮先完成服务和测试。接入现有 `cyberboss-tools` MCP server 时提供：

- `cyberboss_calendar_day`
- `cyberboss_calendar_range`
- `cyberboss_todo_list`
- `cyberboss_todo_create`
- `cyberboss_todo_update`
- `cyberboss_todo_complete`
- `cyberboss_anniversary_list`
- `cyberboss_anniversary_count`
- `cyberboss_daily_overview`

MCP handler 只负责输入校验、调用服务和整理输出，不实现日期或存储逻辑。

## 7. 迭代顺序

1. 建立日期工具、节日规则和 2026 年官方休班数据。
2. 完成日历查询与测试。
3. 完成 JSON 存储、待办与纪念日服务及测试。
4. 完成日概览聚合与测试。
5. 接入现有应用配置和 MCP tool host。
6. 增加年度数据同步命令、来源校验和更新审计。
7. 未来按需增加 HTTP API、前端和提醒/注入。

## 8. 验收标准

- 能准确区分普通周末、法定放假和调休工作日。
- 能识别情人节、七夕和中秋，且不把“节日”误当成“放假”。
- 无日期待办不会出现在某天概览；计划日或截止日在目标日期的待办会出现。
- 纪念日计数规则明确，跨年下一次周年计算正确。
- 所有状态文件可放在外部 state 目录，业务模块不依赖前端或 MCP。
- 新增自动化测试通过，且不改变现有时间线模块语义。
