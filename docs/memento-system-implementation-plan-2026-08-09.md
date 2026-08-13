# 小家纪念物系统实现计划

> 日期：2026-08-09  
> 状态：第一版已实施

## 目标

给苏苏和卫星做三个体验独立、能够真正生成和留下成品的小功能：

- 礼物：包装、送达、拆开、收藏，重点是惊喜与揭晓顺序；
- 明信片：正反面、寄件人、收件人、日期和短话，重点是从一个人寄到另一个人的通信；
- 旅游卡片：地点、照片、同行者和当时发生的小事，重点是共同经历。

它们不是效率工具，也不需要用“有用”证明存在。卫星可以在自己的时间里给小鱿包一件礼物、寄一张短短的明信片，或者把一次真实或想象中的同行做成卡片；苏苏以后仍能从小柜子里把它找回来。

## 第一版边界

第一版直接完成三种成品，但不做万能编辑器、拖拽排版、账户系统或复杂前端：

1. 本地 JSON 记录和独立资产目录；
2. 每种纪念物独立 service 和固定 SVG 渲染器；
3. MCP 创建、读取与状态动作；
4. 礼物未拆前不从读取接口泄露秘密；
5. Telegram 支持礼物拆开、收藏和明信片翻面 callback；
6. 为以后 HTTP/前端保留稳定的 service 方法、public view 与 asset ID。

## 分层

```text
MCP / Telegram callback / 未来 HTTP API
                    ↓
GiftService / PostcardService / TravelCardService
                    ↓
MementoStore + MementoAssets
                    ↓
~/.cyberboss/mementos/<id>/record.json + assets/*.svg
```

约束：

- MCP 不直接写 JSON、不画图片、不判断状态；
- renderer 不发送消息、不改变状态；
- store 不理解礼物、明信片或旅行语义；
- Telegram callback 只把动作交还给 agent，不持有业务规则；
- 未来 HTTP API 只需复用同一批 service。

## 基础记录

```js
{
  id,
  type: "gift" | "postcard" | "travel_card",
  schemaVersion: 1,
  createdAt,
  updatedAt,
  createdBy,
  givenTo,
  status,
  assetIds: [],
  data: {}
}
```

公开接口返回 `publicData` 和 `availableActions`，不直接把内部 record 原样交给观看者。礼物的 `secret` 只有在 `opened / collected` 后才进入 public view。

## 第一版 service 契约

```js
mementoService.list({ type, status, viewerId })
mementoService.read({ id, viewerId })

giftService.send(input)
giftService.open({ id, actorId })
giftService.collect({ id, actorId })

postcardService.send(input)
postcardService.flip({ id, actorId })

travelCardService.create(input)
```

所有输入使用对象，所有结果均可 JSON 序列化。以后增加字段不会破坏参数顺序。

## MCP 工具

- `cyberboss_memento_list`
- `cyberboss_memento_read`
- `cyberboss_gift_send`
- `cyberboss_gift_open`
- `cyberboss_gift_collect`
- `cyberboss_postcard_send`
- `cyberboss_postcard_flip`
- `cyberboss_travel_card_create`

创建工具返回 public view、生成的 SVG 路径和适合渠道使用的 callback 标记。发送文件仍可复用现有 `cyberboss_channel_send_file`；未来可把“创建＋发送”收进 channel-aware orchestrator，不改变核心 service。

## Telegram callback

callback_data 保持短小，只保存动作与 ID：

```text
gift:open:<id>
gift:collect:<id>
postcard:flip:<id>
```

adapter 将其转换为一条内部动作请求，agent 调用对应 MCP 工具并把新资产发回；业务状态仍由 service 校验。

## 前端保留接口

以后新增 `memento-api-server.js`，HTTP handler 直接调用 service：

```text
GET  /api/mementos
GET  /api/mementos/:id
POST /api/gifts
POST /api/gifts/:id/open
POST /api/gifts/:id/collect
POST /api/postcards
POST /api/postcards/:id/flip
POST /api/travel-cards
GET  /api/memento-assets/:assetId
```

前端不读取本地 JSON，不拼绝对路径，不自行修改 status。按钮由 `availableActions` 决定。

## 兼容与升级

- 所有记录带 `schemaVersion: 1`；
- store 读取时经过统一 normalize/migrate；
- 不认识的未来版本拒绝覆盖；
- record 保存 asset ID，相对路径只由 assets 层解析；
- 旅游卡片现在就保存 `mode: real | imagined | if`，不把想象旅行冒充现实经历。

## 验收

1. 能创建一件包装中的礼物，未拆接口看不到内部内容；
2. 能拆开、生成打开后的成品并收藏；
3. 能生成明信片正反面并翻面；
4. 能生成带地点、同行者、小事和 `mode` 的旅游卡片；
5. 三者都能在共同柜子中列出和读取；
6. Telegram callback 能准确携带 ID；
7. 未来前端无需直接访问存储或复制业务逻辑；
8. 语法、service、工具与 callback 测试通过。
