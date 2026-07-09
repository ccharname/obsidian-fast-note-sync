# 同步协议流水线化设计稿

> 目标版本：客户端 **2.3.0** / 服务端 **3.6.0**
> 日期：2026-07-09
> 范围：方向①（上行/下行滑动窗口流水线化）+ 方向③（握手合并 + folder 屏障去除）
> 前置分析：见同日协议 E2E 效率分析（上行 stop-and-wait 逐批 BatchAck、下行 stop-and-wait 逐页 PageAck、auth/clientinfo 双 RTT、folder 30s 硬屏障四项为主要 RTT 瓶颈）
>
> 本设计建立在两仓当前 HEAD 之上（客户端 861ee4f / 服务端 ed3d04e0），已消化以下既有改动：
> - 服务端：SyncDownChunkNum 默认 200（internal/config/app.go:78）；PageAck mismatch 兜底重发当前页（ws_note.go:1141-1160）；BatchIndex 去重 ReceivedIndexes（ws_sync_batch_cache.go:32-41）；下载缓存元数据化 + 发页时按需回填正文 FillContent（ws_sync_download_cache.go:33,97-121）
> - 客户端：分页进度按 pageIndex 去重 receivedPageIndexes、isLast 不回退（sync_progress_tracker.ts:33,220-239）；SendBinary 三态返回（websocket_client.ts）

---

## 1. 目标与非目标

### 目标

| # | 目标 | 量化预期 |
|---|------|---------|
| G1 | 上行清单分批从 stop-and-wait 改为滑动窗口（默认 W_up=8 批在途） | 1 万文件全量上行清单从 ⌈N/100⌉≈100 串行 RTT 降至 ≈⌈100/8⌉=13 个窗口周期 |
| G2 | 下行分页从 stop-and-wait 改为服务端预推窗口（默认 W_down=4 页在途） | 1 万变更下行从 50 串行「RTT+写盘」段降至 ≈13 个窗口周期，且写盘时间与网络往返重叠 |
| G3 | 握手合并：sync 启动所需协商参数随 auth 响应返回，消除 ClientInfo 独立 RTT 阻塞与「默认值抢跑」竞态 | 冷启动关键路径少 1 RTT；chunkNum/协议协商在首批发出前确定 |
| G4 | 去除 folder 30s 硬屏障，四类清单并发发出 | 每轮同步少 1 个串行 FolderSyncEnd RTT + 消除 30s 挂起长尾 |
| G5 | **全程能力协商，双向向后兼容**：旧客户端+新服务端、新客户端+旧服务端均自动退回 stop-and-wait，无强制升级 | 无 3.5.0 式硬断裂 |

### 非目标

- 不改同步模型（仍为 lastTime 游标 + pathHash/contentHash 比对 + 三路合并），不引入 version vector / oplog / Merkle 树（方向②另议）。
- 不做断线会话恢复：重连后仍以新 context 重启整轮同步（见 §4.6 决策）。
- 不改附件二进制分片通道（上行 1MB / 下行 512KB chunk session），其已是流水线。
- 不改正文内联下发（方向④另议）；FillContent 按需回填机制原样保留。
- 不改 concurrencyLimiter 语义（默认值调整见 C6 顺手项，非本设计核心）。

---

## 2. 能力协商机制与字段变更

### 2.1 协商总原则

**一切新行为由「双方显式声明」开启，任一方缺席即退回现行为。** 协商结果在 auth 往返内确定，sync 启动前生效。

已验证的兼容性事实（这是整个协商设计可行的基础）：

1. **Auth 响应恒为 JSON 文本**：服务端连接的 `useProtobuf` 只在 ClientInfo handler 里由 `setClientInfo` 设置（pkg/app/websocket.go:1194-1198），auth 阶段必为 false，`ToResponse` 在 `UseProtobuf()==false` 时走 JSON 编码（websocket.go:641）。因此 auth 响应加字段 = JSON object 加 key，**旧客户端 JSON.parse 后忽略未知 key，天然向后兼容，无需动 proto**。
2. **WSResponse 信封可加 proto 字段**：proto3 加新编号字段对旧解码端是未知字段直接跳过；客户端 pb 由 `pnpm proto`（package.json:21 `pbjs -t static-module`）从服务端仓库同一份 `internal/proto/v1/sync.proto` 生成（客户端仓库无 .proto 源文件，只消费生成产物 src/pb/v1/sync.js）。给已有 message 加字段时 protobuf_mapper.ts 的 switch 不用改（`create`/`toObject` 自动携带）。
3. **URL query 加参数**：旧服务端忽略未知 query 参数；客户端 getWsUrl 已带 client/clientName/clientVersion/protocol（websocket_manager.ts:114-135）。
4. **多余的 BatchAck 对旧客户端无害**：客户端 BatchAck handler 只是 `emit` 到事件总线（operator.ts:227-230），无监听者时静默丢弃。

**结论：本设计所有改动均可做成向后兼容，不存在「做不到向后兼容」的方向。** 唯一需要注意的半例外见 §2.4（WSResponse.pageIndex 在 JSON 模式下同样是加 key，兼容）。

### 2.2 客户端能力声明（URL query）

`getWsUrl`（websocket_manager.ts:114）新增两个 query 参数：

```
&pv=2          // protocol version：声明客户端支持 v2 握手协商（auth 响应携带协商块、窗口流水线、pb 提前升级）
&pb=1          // 客户端本地 protobufEnabled 设置（1/0）。现状 URL 恒带 protocol=protobuf 与真实设置脱节，pv=2 起以 pb 为准
```

服务端 `WebsocketClient` 在 HTTP upgrade 时解析并存到连接字段（与现有 `c.Protocol` 同处解析，pkg/app/websocket.go 的 upgrade/accept 路径）：`c.ProtoVersion int`、`c.PbEnabled bool`。

### 2.3 服务端协商块（auth 响应，JSON）

`Authorization` 成功响应（pkg/app/websocket.go:1165-1170）的 data map 由 `map[string]string` 改为 `map[string]interface{}`，在 `c.ProtoVersion >= 2` 时追加协商块：

```jsonc
{
  "version": "...", "gitTag": "...", "buildTime": "...", "changelog": "...",   // 现有字段不动
  // ---- 以下 pv>=2 才追加 ----
  "syncUpChunkNum": 100,        // = Config().App.SyncUpChunkNum
  "syncDownChunkNum": 200,      // = Config().App.SyncDownChunkNum
  "pipelineWindowUp": 8,        // 上行窗口。0 = stop-and-wait（回滚开关）
  "pipelineWindowDown": 4,      // 下行窗口。0 = stop-and-wait（回滚开关）
  "protobufAck": true           // = (c.Protocol=="protobuf" && c.PbEnabled)，服务端确认本连接将启用 pb
}
```

- 新增服务端配置项（internal/config/app.go App 段）：`pipeline-window-up` default `8`、`pipeline-window-down` default `4`，上限钳制 32/16。后台管理 admin_dto/handler_admin_control 照 SyncDownChunkNum 模式透出。
- 兼容矩阵：

| 客户端 \ 服务端 | 旧（≤3.5.x） | 新（3.6.0） |
|---|---|---|
| 旧（≤2.2.x） | 现状 | auth 响应多出的 key 被忽略；无 pv 参数 → 服务端不启用 pb 提前升级、窗口协商无从谈起 → 服务端窗口行为由客户端 ack 驱动，退化正确性见 §3.4/§4.4 → **stop-and-wait** |
| 新（2.3.0） | auth 响应无 `pipelineWindowUp` 字段 → 客户端判定服务端为 v1 → 全部退回现行为（等 ClientInfo 升 pb、stop-and-wait、保留 folder 屏障可去除项见 §6 说明） | 全量新行为 |

### 2.4 proto 变更（internal/proto/v1/sync.proto）

只加字段，不加新 message、不加新 action。改完在客户端仓库跑 `pnpm proto` 重新生成 sync.js/sync.d.ts。

```protobuf
// 1) WSResponse 信封：下行明细消息标注所属页（下行窗口的页归属与幂等去重依据，见 §4）
message WSResponse {
    // ... 现有 1-7 不动 ...
    int32 pageIndex = 8;   // 该明细/页消息所属下载页码；非分页消息为 0。发送端：仅 pv>=2 连接填写
}

// 2) CheckVersionInfo：ClientInfo 响应同步携带窗口参数（兜底路径，供旧握手流程/后台改配置后广播）
message CheckVersionInfo {
    // ... 现有 1-15 不动 ...
    int32 pipelineWindowUp = 16;
    int32 pipelineWindowDown = 17;
}
```

对应 Go 侧：`code.Code` 响应链加 `WithPageIndex(int)`（照 `WithContext` 模式，pkg/code），JSON 序列化输出 `"pageIndex"` key；`pkgapp.CheckVersionInfo`（pkg/app/app.go:41-42 旁）加两个字段，`internal/app/app.go:226-227` 旁赋值。

客户端 protobuf_mapper.ts：`deReceivePacket`（580-598 行）从 WSResponse 透传 `pageIndex` 到解出的对象上（一行）；`handleStructuredMessage`（websocket_manager.ts:338-340）把 `data.pageIndex` 随 context 一起并进 payload。JSON 模式天然透传（明细 payload 是整个 WSResponse JSON）。

### 2.5 上/下行控制消息

**不新增任何消息类型。** BatchAck / PageAck 消息结构不变，仅语义升级：

- `XxxSyncBatchAck{context, batchIndex}`：从「允许发下一批」变为「批 batchIndex 已收到」（窗口滑动信号）。
- `XxxSyncPageAck{context, vault, pageIndex}`：从「请求下一页」变为「页 pageIndex 已处理完」（流控水位）。

语义升级由协商值控制，双方均按协商结果选择新旧行为，消息线格式零变更——这是兼容性的第二根支柱。

---

## 3. 上行窗口协议

### 3.1 时序（W_up=8，totalBatches=20 示例）

```
客户端                                          服务端
  │ ── 批0..7 连发（不等 ack，8 批在途）──────────► 逐批 markBatchReceived → append
  │ ◄── BatchAck{0} ──  在途7 → 发批8               → 回 BatchAck{i}（含最后一批，见 3.3）
  │ ◄── BatchAck{1} ──  在途7 → 发批9
  │        ...（ack 与发送流水线重叠）...
  │ ── 批19（最后一批）发出 → 触发 onLastBatchSent 回调（pendingNoteModifies 落账）
  │ ◄── BatchAck{19}
  │ ◄── (received==total) doNoteSync → NoteSyncPage/明细/NoteSyncEnd
```

关键路径 ≈ ⌈totalBatches/W⌉ × RTT，而非 totalBatches × RTT。

### 3.2 客户端状态机（改造 sendSyncInBatches，operator.ts:993-1052）

每类型一个发送会话对象：

```
状态: nextToSend=0, inFlight=Map<batchIndex,{payload, retries, timer}>, acked=Set<int>
W = min(协商 pipelineWindowUp, 32)；W==0 或服务端 v1 → 走现有 stop-and-wait 代码路径（保留原函数分支，不删）

循环:
  while nextToSend < totalBatches && inFlight.size < W:
      发送批 nextToSend（经现有 SendMessage → waitForBufferDrain 5MB 背压）
      inFlight.set(idx, {payload, retries:0, timer: setTimeout(onTimeout(idx), 10_000)})
      nextToSend++
      若 idx == totalBatches-1: 触发 onLastBatchSent 回调（时机与现状"最后一批 send 后调 onLastBatchAcked"语义一致）

事件 BatchAck{context, batchIndex}:
  context 不匹配 → 忽略（现有 context 过滤已在 websocket_manager.ts:328-334 做了一层）
  inFlight.delete(batchIndex)（清 timer）; acked.add(batchIndex)
  回到循环补发

事件 onTimeout(idx):
  retries >= 3 → 会话失败：reject → 上抛到 handleSync catch（operator.ts:907）→ sync failed 复位（现有路径）
  否则 retries++，重发同 payload（服务端幂等，见 3.3），重置 timer=10s

事件 收到本类型 SyncEnd:
  视为全部批隐式 ack：清空 inFlight 所有 timer，会话成功结束
  （防护：服务端集齐后 doSync 期间/之后到达的重传见 3.3 尾注）

会话结束条件: acked.size == totalBatches 或 收到 SyncEnd
连接断开(onClose): 清空全部 timer，会话直接终止（重连走新 context 整轮重启，现有行为）
```

- **与 bufferedAmount 背压的关系**：窗口控制「未确认批数」（协议层），bufferedAmount>5MB 控制「socket 写缓冲」（传输层），两者正交叠加。W=8×100 条×约 200B/条 ≈ 160KB ≪ 5MB，正常不会触碰传输层背压；触碰时 SendMessage 内部 await drain，窗口循环自然暂停——无需额外协调。
- **totalBatches==1 快速路径**：单批直接发（服务端 totalBatches<=1 走 fast path 不进 cache，ws_note.go:661），无窗口逻辑。
- **超时值**：单批重传超时 10s（< 现有整批 15s ack 超时）；整轮同步仍受 checkSyncCompletion 300s 总兜底（operator.ts:49）。

### 3.3 服务端改动（ws_note.go:650-719 及 file/setting/folder 同构三处）

现状已天然支持乱序/重复归位（Items 集合语义，doNoteSync 按 pathHash 建 map 消费，顺序无关；ReceivedIndexes 幂等去重）。仅需两处小改：

1. **集齐时也回 BatchAck**：现状 `received == total` 时直接 doSync 不回最后那批的 ack（ws_note.go:684-692 只在 `received < total` 分支回）。改为无条件先回 `BatchAck{batchIndex}` 再判断集齐与否。对旧客户端：最后一批的多余 BatchAck 被无监听 emit 丢弃（§2.1 事实 4），无害。
2. **重复批在 cache 已删除后的处理**：doSync 后 `syncBatchDelete`，此时迟到重传会经 `syncBatchGetOrCreate` 重建一个永不集齐的孤儿 entry（TTL 5min 清理，现状潜在小漏洞）。改法：重建的 entry 反正会回 BatchAck（改动 1 使然），客户端此时多半已收到 SyncEnd 终止会话，ack 被忽略；孤儿 entry 交 TTL。**接受现状，不做会话号防护**——客户端在 SyncEnd 后已停止重传（3.2），该窗口极窄。工单里只要求把这一情况打 Debug 日志。

BatchAck 的发送与 stop-and-wait 完全同构，服务端**没有「窗口模式开关」**——窗口纯由客户端驱动（客户端连发几批，服务端就逐批 ack 几批）。这意味着：**新客户端 + 旧服务端也能跑上行窗口吗？不能启用**——旧服务端无 ReceivedIndexes 前身版本？有（ac4c273f 已在 3.5.x 线）。但旧服务端 `received==total` 不回最后批 ack 且无 pv 协商字段，客户端无法区分更旧版本的去重能力，**统一策略：auth 响应无协商块 → 上行退回 stop-and-wait**（保守正确）。

### 3.4 SyncEnd 判定时机

不变：服务端在 `received == total` 后 doSync，diff 完成发 `NoteSyncEnd{counts}`（ws_note.go:1073 附近）。客户端 `receiveSyncEndWrapper`（operator.ts:290）逻辑不动。唯一时序差异：窗口模式下 End 可能在客户端仍持有 inFlight timer 时到达 → 3.2 的「SyncEnd 隐式 ack」规则覆盖。

### 3.5 异常路径汇总

| 异常 | 行为 |
|---|---|
| 单批 ack 丢失 | 10s 重传，服务端 markBatchReceived 去重 + 重发 ack（ws_note.go:667，现有） |
| 单批重传 3 次仍失败 | 会话 reject → handleSync catch → sync failed 状态复位，用户可手动重试 |
| 断线 | onClose 清 timer + concurrencyLimiter.clear（现有 websocket_manager.ts:147-154）；重连新 context 重启整轮；服务端孤儿 batch cache 由 5min TTL 回收 |
| 服务端处理单批出错（BindAndValid 失败等） | 现状回错误响应不回 ack → 客户端该批重传 3 次后会话失败（结构性错误重传也无用，可接受） |
| 客户端发送中 bufferedAmount 持续 >5MB | SendMessage 内部 drain 等待，窗口停摆但 timer 仍走 → 若 10s 内 drain 不完成会触发无谓重传。**工单要求：批的重传 timer 从「send 实际写入 socket 后」起算**（SendMessage resolve 后再挂 timer） |

---

## 4. 下行窗口协议

### 4.1 时序（W_down=4，totalPages=10 示例）

```
客户端                                          服务端 (syncDownloadEntry)
  │ ── XxxSyncEnd 处理后发首拉 PageAck{-1} ──────► AckedPage=0, 连发页 0..3（SentPage=4）
  │ ◄── Page{0,pageIndex=0} + 200条明细(信封带 pageIndex=0)
  │ ◄── Page{1,...} ◄── Page{2,...} ◄── Page{3,...}   （4 页在途，客户端边收边写盘）
  │ ── 页0 全部写盘完成 → PageAck{0} ────────────► AckedPage=1 → 发页4（SentPage=5）
  │ ── PageAck{1} ──────────────────────────────► 发页5
  │        ...（写盘与网络传输重叠）...
  │ ◄── Page{9, isLast=true} + 明细 → 服务端发完即 syncDownloadDelete（现状保留）
  │ （isLast 页不发 ack，现状保留 sync_progress_tracker.ts:187-188）
```

### 4.2 服务端状态机（ws_sync_download_cache.go + 四处 PageAck handler）

`syncDownloadEntry` 字段变更：`CurrentPage` 语义拆分为：

```go
SentPage  int  // 已发出的页数（下一待发页码）。替代 CurrentPage 的"发送游标"角色
AckedPage int  // 已确认处理完的最高连续页 + 1（初始 0）
Window    int  // 本连接协商的 W_down；0 = stop-and-wait
```

```
构造 entry 时（ws_note.go:1090-1101 等四处）: Window = 客户端 pv>=2 ? Config.PipelineWindowDown : 0

pump(entry)（持锁）:  // 新增内部函数，替代"ack 一次发一页"
  for SentPage < totalPages && SentPage < AckedPage + max(Window,1):
      sendSyncPage(第 SentPage 页)   // 明细信封 WithPageIndex(SentPage)
      SentPage++
      若该页 isLast: syncDownloadDelete（现状保留，发完即毁）; return

PageAck{pageIndex=-1}（首拉，四处 handler）:
  AckedPage=0; pump()          // Window=0 时 pump 恰好只发 1 页 = 现状 stop-and-wait ✓

PageAck{pageIndex=n>=0}:
  n < AckedPage-1        → 过期重复 ack：忽略（Debug 日志）
  n == AckedPage-1       → 客户端重发上一 ack（没收到后续页）→ 回退 SentPage=AckedPage 重发窗口（见 4.5）
  AckedPage-1 < n < SentPage → AckedPage = n+1; pump()
  n >= SentPage          → 异常（客户端 ack 未发过的页）：Warn 日志 + 忽略
```

**stop-and-wait 退化正确性**：Window=0 时 `pump` 每次最多发 `AckedPage+1` 页即停 —— 收到 ack(n) → AckedPage=n+1 → 发页 n+1 → 停。与现状逐页行为逐消息等价（旧客户端每处理完一页发一个 ack），mismatch 兜底逻辑被 4.2 的分支表吸收（`n==AckedPage-1` 分支即原「重发当前页」兜底，64be9cbc 的意图完整保留）。**因此四处 PageAck handler 的现有 mismatch 代码（ws_note.go:1141-1176）整体替换为上述分支表，新旧客户端统一走它。**

### 4.3 客户端改造（页归属 + 接收/写盘解耦）

现状问题：`syncPageStateMap` 每类型单页状态（set 覆盖，operator.ts:256-263），progress tracker 的 `downloadPageIndex/downloadPageDone` 也是单页计数（sync_progress_tracker.ts:171-196）——多页在途会互相覆盖。

改造方案（利用 §2.4 的明细信封 pageIndex）：

```
TypeProgress 内（sync_progress_tracker.ts）:
  pages: Map<pageIndex, {totalCount, completedCount, acked}>   // 替代单页 downloadPageIndex/Done/Count 三字段
  receivedPageIndexes: Set<number>   // 保留（页级去重，现有）

handleSyncPage（operator.ts:241，收到 Page 元数据）:
  receivedPageIndexes.has(pageIndex) → 整页重复（服务端窗口回退重发）→ 登记"本页明细将重复到达，
     按 pageIndex 丢弃"标记后 return（见 4.5）
  pages.set(pageIndex, {totalCount, completedCount:0, acked:false})
  totalCount==0 && !isLast → 立即 ack（现状保留 operator.ts:265-275）

明细消息（receiveNoteSyncModify 等）:
  payload 已带 pageIndex（§2.4 透传）
  写盘仍是现有 async handler 并发执行（receiveOperators 分发处 void handler()，websocket_manager.ts:341），
     按 path 的 lockManager 串行化同文件写（现有）——接收循环不被写盘阻塞，天然解耦 ✓
  写盘完成（completed++ Proxy 触发 recordCompleted）时:
     pages.get(pageIndex).completedCount++
     若 completedCount == totalCount && !acked && !该页 isLast:
        acked=true; sendSyncPageAck(type, pageIndex)   // main.ts:107-134 现有实现复用

旧服务端（明细无 pageIndex 字段）: payload.pageIndex === undefined → 回退现有单页计数路径
   （保留原 recordCompleted 全局计数分支），服务端本来也是 stop-and-wait，语义不变 ✓
```

- `isTypeFullyDone`（sync_progress_tracker.ts:272-279）判定不变：uploadComplete && allPagesReceived && downloadCompleted >= receivedTaskTotal，与页归属无关。
- 乱序 ack 是允许的（页 2 明细比页 1 先写完 → 先 ack 2 后 ack 1）：服务端 4.2 分支表按 `AckedPage` 连续水位处理，`n > AckedPage-1` 的都推进水位——**注意这里选择「最高 ack 水位」而非「连续 ack 集合」语义：ack(2) 到达即视为页 ≤2 全部处理完**。客户端为满足该约定，**发 ack(n) 前必须确认页 ≤n 均已 completedCount==totalCount**（在 sendAck 前加一个 `minUnfinishedPage` 检查，未满足则暂缓，等前页完成时一起补发最高完成页）。这是客户端工单的关键验收点。

### 4.4 兼容矩阵（下行）

| 客户端 \ 服务端 | 旧 | 新 |
|---|---|---|
| 旧 | 现状 | entry.Window 按连接 pv 判定为 0 → pump 单页步进 = 现状；明细信封多出 pageIndex=0（JSON 多 key / pb 未知字段）被忽略 |
| 新 | 明细无 pageIndex → 客户端退回单页计数路径；服务端逐页发 → stop-and-wait | 全量窗口 |

### 4.5 异常路径汇总

| 异常 | 行为 |
|---|---|
| 某页明细部分丢失（理论上 TCP 内不发生，实际对应服务端发送中断/客户端处理丢弃） | 该页 completedCount 永达不到 totalCount → 不 ack → 服务端不再推进；整轮受 300s 总兜底超时复位。**不做页内重传**（复杂度不值：TCP 有序可靠，丢失只来自 bug） |
| 客户端 ack 丢失 | 客户端侧：无重发机制（现状同）。服务端 AckedPage 停滞 → 后续页发完窗口后停摆 → 300s 兜底。**补充防护**：客户端对「已有未 ack 完成页 + 15s 无新明细到达」重发最高完成页 ack（轻量 timer，挂在 progressTracker） |
| 服务端收到重复 ack(n==AckedPage-1) | 回退 SentPage=AckedPage 重发窗口内页；客户端按 receivedPageIndexes 幂等丢弃整页重复明细（4.3：重复 Page 元数据 → 后续 totalCount 条同 pageIndex 明细全部丢弃，靠信封 pageIndex 识别，**这是 pageIndex 字段存在的第二个理由**） |
| 断线 | 客户端重启整轮（新 context）；服务端 entry 由 10min TTL 回收 |
| isLast 页 | 发完即 syncDownloadDelete（现状），客户端不 ack（现状），窗口协议不触碰 |

### 4.6 会话恢复决策

**明确不做**。10min TTL cache 不用于跨连接恢复：重连后客户端以新 context 重启整轮同步（现状行为，f01ec65 已修好旧会话迟到清状态问题）。理由：增量同步幂等（hash 对比，已落盘页在下一轮 diff 中自动不再出现在变更集），重启成本 = 一次本地扫描（hash 有缓存）+ 少量 RTT；会话恢复需要 context 持久化 + 双端游标核对，复杂度/收益比不划算。TTL cache 仅服务于同连接内的窗口状态。

---

## 5. 握手合并

### 5.1 服务端（pkg/app/websocket.go Authorization, 1092-1173）

1. 解析 `pv`/`pb` query（§2.2）。
2. auth 成功响应 data 追加协商块（§2.3）。
3. **pb 提前升级**：`c.ProtoVersion >= 2` 时，在发送 auth 成功响应（JSON）**之后**立即 `c.setUseProtobuf(c.Protocol=="protobuf" && c.PbEnabled)`（复用 setClientInfo 的锁字段，7e37f411 已加锁）。此后该连接所有下行消息按 pb 编码。旧客户端无 pv → 不提前升级，仍等 ClientInfo（现状路径完整保留）。
4. ClientInfo handler（websocket.go:1176-1227）不动：pv2 连接重复 setUseProtobuf 是幂等的；CheckVersionInfo 照常返回（多带 §2.4 两个窗口字段）。

### 5.2 客户端（websocket_manager.ts + websocket_client.ts + version_manager.ts）

1. `handleStructuredMessage` 的 `ClientReceiveAuth` 成功分支（websocket_manager.ts:270-284）：
   - 在调用 `StartHandle()` **之前**，从 `data.data` 读取协商块写入 `syncState`：`syncUpChunkNum`/`syncDownChunkNum`/`pipelineWindowUp`/`pipelineWindowDown`（字段存在才写，`?? 保留默认`——旧服务端响应无这些 key 时维持 sync_state.ts:24-27 默认值 + 后续 ClientInfo 路径更新，即现状）。
   - 新增 `syncState.negotiated: boolean`，pv2 协商块到达置 true；旧服务端置 false。
   - 若 `data.data.protobufAck === true` 且本地 `settings.protobufEnabled !== false`：立即 `client.useProtobuf = true`（不再等 ClientInfo 响应的 pb 前缀触发，websocket_client.ts:256 该触发保留作旧服务端路径）。
2. **StartHandle 显式等协商**：竞态的根因是 chunkNum 来自 ClientInfo 响应而 sync 不等它。合并后协商块随 auth 到达，而 `StartHandle` 本来就在 auth 分支内被调用（websocket_manager.ts:283）——只要保证第 1 步写入先于 `StartHandle()` 调用（同一同步代码块内的语句顺序），**无需 await/轮询**。工单验收：在 `StartHandle` 入口断言 `syncState.negotiated || 服务端为 v1`，并加注释禁止把协商写入移到 StartHandle 之后。
3. `sendClientInfo()` 保留原位（auth 后发送，websocket_manager.ts:282），仅上报元数据与版本检查，其响应更新 versionManager（version_manager.ts:106-146 不动，pv2 下其中 chunkNum 写入变为幂等覆盖）。
4. sync_progress_tracker.ts:189 的 `setDownloadTotal(type, total, syncDownChunkNum = 100)` 默认参数与 sync_state 默认 50 不一致（现存瑕疵）：调用方恒显式传参（operator.ts:303），工单顺手把默认参数改 200 对齐服务端新默认，消除迷惑。

### 5.3 收益核算

- protobuf 生效点从「ClientInfo 响应后」提前到「auth 响应后」：首轮 FolderSync/NoteSync 清单必然以 pb 发出（现状竞态下可能 JSON 抢跑，体积 2-3 倍）。
- chunkNum/窗口参数在首批构造前确定：`sendSyncInBatches` 的 `syncUpChunkNum` 参数默认取 `plugin.syncState.syncUpChunkNum`（operator.ts:1009），时序保证其已是服务端配置值而非默认 100。
- ClientInfo 从关键路径移除：冷启动到首批发出 = 握手(≈2 RTT) + auth(1 RTT) + 本地扫描，比现状少 1 RTT 且无竞态。

---

## 6. folder 屏障去除（纯客户端）

### 6.1 改动

`handleRequestSend`（operator.ts:1060-1215）：

1. 删除「第二步」30s 轮询屏障（operator.ts:1093-1113）。
2. 四类 `sendSyncInBatches` 改为并发发起：

```ts
const jobs: Promise<void>[] = [];
if (syncEnabled && shouldSyncNotes) {
  jobs.push(sendSyncInBatches(..."FolderSync"...));
  jobs.push(sendSyncInBatches(..."NoteSync"...));
  if (!cloudPreview...) jobs.push(sendSyncInBatches(..."FileSync"...));
}
if (configSyncEnabled && shouldSyncConfigs) jobs.push(sendSyncInBatches(..."SettingSync"...));
await Promise.allSettled(jobs);   // 任一类失败不阻断其他类；失败类由 300s 兜底复位
```

- 服务端无顺序假设：batch/download cache key 均为 `{context}_{type}` 隔离（ws_sync_batch_cache.go:66-68），vault GetOrCreate 有 singleflight（ws_note.go:732）。
- 四类并发共享一条 WS + bufferedAmount 背压，消息交错无协议影响（每消息自带 type+context）。
- **回退联动**：该项不依赖协商（纯客户端），对旧服务端同样生效。

### 6.2 并发 createFolder 竞态防护点清单（逐点核过代码）

| # | 竞态点 | 现状 | 动作 |
|---|---|---|---|
| 1 | note 下行写盘 vs folder 下行建目录：同一目录并发 create | operator_note.ts:264-278 已有惰性建目录（getFolderByPath 判空 → createFolder → catch 后 getFolderByPath 二次确认，仍不存在才 rethrow） | 保留，无需改 |
| 2 | file 正文写盘同款 | operator_file.ts:1303-1315 与 note 逐字同构 | 保留，无需改 |
| 3 | **file 分片临时目录**：receiveFileSyncUpdate 的 exists→mkdir（operator_file.ts:958-967）与 handleFileChunkDownload 兜底重建（1099-1107） | exists-then-mkdir，两处均**无** "already exists" catch 确认，并发下 mkdir 可能抛错 | **工单 C5：两处包 try/catch，catch 后 adapter.exists 复验，存在则吞、不存在再走现有失败路径（1100-1119 的内存 fallback / session 失败）** |
| 4 | receiveFolderSyncModify 自身重复/与 1、2 并发 | operator_folder.ts:171-179 createFolder catch 后除大小写冲突外吞错不 rethrow | 保留（比 note 版更宽松，可接受：folder 建立失败会被 1/2 兜底） |
| 5 | FolderSyncRename 下行 vs note 往旧路径写 | 屏障从未防护此点（rename 是下行消息，本来就与 note 下行并发）；FolderSyncRename 目标不存在建同名目录分支同 4（operator_folder.ts:304-310） | 维持现状语义，非本设计引入 |
| 6 | FolderSyncDelete vs 并发写入同目录 | 5d0be9a 已做「等待清空超时放弃强删」 | 保留 |

**结论：屏障去除后正确性由「写盘侧惰性建目录」兜底承担，仅第 3 点需要补齐。**

---

## 7. 实现拆分

> 术语：四类 = note/file/setting/folder 的同构四份代码。凡写「四处」指 ws_note.go / ws_file.go / ws_setting.go / ws_folder.go 各一处（folder 无 setting 部分差异自行对照）。

### 7.1 服务端工单（fast-note-sync-service，3.6.0）

**S1 · 协商基础设施**
- 文件：`pkg/app/websocket.go`（upgrade 处解析 pv/pb query 存入 WebsocketClient 新字段 ProtoVersion/PbEnabled；Authorization 1165-1170 响应 map 改 interface{} 并追加协商块；auth 成功后 pv2 提前 setUseProtobuf）；`internal/config/app.go`（App 段加 `pipeline-window-up` default 8、`pipeline-window-down` default 4，读取处钳制 ≤32/≤16、<0 视为 0）；`pkg/app/app.go` + `internal/app/app.go`（CheckVersionInfo 加 PipelineWindowUp/Down 字段并赋值）；`internal/dto/admin_dto.go` + `internal/routers/api_router/handler_admin_control.go`（后台透出两个配置项，照 SyncDownChunkNum 模式）。
- 验收：pv=2&pb=1 连接 auth 响应含 5 个协商字段且随后消息为 pb 编码；无 pv 连接 auth 响应与 3.5.x 逐字节等价（不多 key）、pb 升级仍走 ClientInfo；`pipeline-window-up: 0` 时协商块 pipelineWindowUp=0。

**S2 · proto 与信封**
- 文件：`internal/proto/v1/sync.proto`（WSResponse 加 field 8 pageIndex；CheckVersionInfo 加 field 16/17）→ 重新生成 sync.pb.go；`pkg/code`（Code 加 WithPageIndex，照 WithContext 模式）；`internal/routers/websocket_router/protobuf_mapper.go`（WSResponse 编码路径带 pageIndex；CheckVersionInfo 映射加两字段，参照 621-622 行 SyncUpChunkNum 模式）。
- 验收：pb 与 JSON 两种模式下，分页明细响应均携带 pageIndex；非分页消息 pageIndex=0/缺省；旧客户端（不认识该字段）联调无异常。

**S3 · 上行：集齐批也回 BatchAck**
- 文件：四处 `XxxSync` handler（ws_note.go:684-692 及同构三处）：把 BatchAck 发送移到 `received < total` 判断之前无条件执行；cache 已删后迟到重传重建孤儿 entry 的分支加 Debug 日志。
- 验收：totalBatches=N 的上传，服务端恰好回 N 个 BatchAck（含最后一批）；对 2.2.x 客户端回归——最后一批多出的 ack 不引起任何行为变化；重复 BatchIndex 仍只 append 一次且重发 ack（现有 ReceivedIndexes 用例回归）。

**S4 · 下行：窗口 pump**
- 文件：`ws_sync_download_cache.go`（entry 字段 CurrentPage → SentPage/AckedPage/Window；新增 pump(c, entry) 持锁循环，内部调 sendSyncPage；sendSyncPage 发明细时 WithPageIndex(page)）；四处 entry 构造点（ws_note.go:1090-1101 等：Window 按连接 ProtoVersion 与配置赋值）；四处 `XxxSyncPageAck` handler（ws_note.go:1117-1176 等：现有 mismatch 兜底整段替换为 §4.2 分支表 + pump）。
- 验收：
  - Window=0（旧客户端或配置 0）：行为与 3.5.x 逐消息等价（每 ack 一页发一页；ack(n)==AckedPage-1 时重发当前页 = 64be9cbc 兜底回归用例通过）。
  - Window=4：首拉后立即连发 min(4,total) 页；ack(0) 到达发页 4；乱序 ack(2) 先到 → AckedPage=3、连发至页 6。
  - 重复 ack(AckedPage-1) → SentPage 回退重发窗口，明细信封 pageIndex 与首次一致。
  - isLast 页发完 cache 删除、后续 ack 打 Warn 不 panic。

**S5 · 回归与压测**
- 单测：syncBatchEntry 并发 markBatchReceived；pump 状态机表驱动测试（每个 §4.2 分支）。
- 集成：模拟 200 页 × Window=4 下行 + 100 批 × 客户端窗口 8 上行，校验 doSync 输入集合与 stop-and-wait 模式逐元素相等。
- 验收：`go test ./...` 全绿；1 万笔记 mock 库对比新旧模式同步结果（服务端 DB 状态、下发明细集合）一致。

### 7.2 客户端工单（fastnotesync，2.3.0）

**C1 · 协商与握手合并**
- 文件：`src/lib/sync/websocket_manager.ts`（getWsUrl 加 `&pv=2&pb=${protobufEnabled?1:0}`；ClientReceiveAuth 成功分支在 StartHandle 之前解析协商块写 syncState、置 negotiated、protobufAck 时立即 client.useProtobuf=true）；`src/lib/sync/sync_state.ts`（加 `pipelineWindowUp=0`/`pipelineWindowDown=0`/`negotiated=false` 字段，均默认关闭）；`src/lib/utils/version_manager.ts`（updateFromClientInfo 补读 pipelineWindowUp/Down，幂等覆盖）；`src/lib/sync/sync_progress_tracker.ts:189`（默认参数 100 → 200 对齐）。
- 验收：对 3.6.0 服务端——auth 响应后 syncState 四个协商值即为服务端配置、首条 FolderSync 以 pb 帧发出；对 3.5.x 服务端——协商值保持默认（window=0）、pb 升级仍在 ClientInfo 后、同步行为与 2.2.x 一致。

**C2 · 上行窗口 sendSyncInBatches**
- 文件：`src/lib/sync/operator.ts`（993-1052 重写为 §3.2 状态机；`W = syncState.pipelineWindowUp`，W==0 走保留的原 stop-and-wait 分支；重传 timer 在 SendMessage resolve 后启动；SyncEnd 隐式 ack 挂在 receiveSyncEndWrapper 里调会话的 settleAll()；onClose 清 timer——挂在 websocket_manager onClose 现有清理处 147-154）。
- 验收：W=8 时 20 批仅需 ⌈20/8⌉ 个窗口周期（用日志时间戳验证批发送不等 ack）；人为丢弃一个 BatchAck → 10s 重传 → 服务端去重 → 同步结果正确；连续丢 3 次 → 本轮 sync failed 且状态位复位（isSyncing/activeSyncContext/timer 全清）；W=0 行为与现版本逐消息一致。

**C3 · 下行页归属与多页在途**
- 文件：`src/lib/sync/sync_progress_tracker.ts`（TypeProgress 加 `pages: Map<number,{totalCount,completedCount,acked}>`；recordCompleted 按明细 pageIndex 归账；ack 前置条件「页 ≤n 全部完成」的 minUnfinishedPage 检查；15s 无明细停滞时重发最高完成页 ack 的轻量 timer；payload 无 pageIndex 时退回现有全局计数路径）；`src/lib/sync/operator.ts`（handleSyncPage 241-276：syncPageStateMap 改为 per-page 登记；重复 pageIndex 的 Page 元数据 → 标记该页明细为「重复丢弃」）；`src/pb/protobuf_mapper.ts`（deReceivePacket 透传 WSResponse.pageIndex）；`src/lib/sync/websocket_manager.ts`（338-340 payload 并入 pageIndex）；四类明细 handler（operator_note/file/config/folder.ts）completed 归账处把 pageIndex 传给 tracker。
- 验收：服务端 Window=4 下 200 页同步——写盘与接收重叠（日志验证 ack(0) 发出前页 1-3 明细已在处理）；乱序完成（构造页 1 大文件慢写）时 ack 仍按连续水位发出；服务端窗口回退重发整页 → 客户端按 pageIndex 幂等丢弃、completed 计数不重复累加、isTypeFullyDone 判定正确；对 3.5.x 服务端（明细无 pageIndex）回归现有单页行为。

**C4 · folder 屏障去除**
- 文件：`src/lib/sync/operator.ts`（handleRequestSend 1060-1215：删 30s 轮询屏障，四类 sendSyncInBatches 改 Promise.allSettled 并发；保留 pendingDelete 集合填充逻辑位置不变）。
- 验收：全量同步含深层新目录（服务端有、本地无）时，note/file 写盘全部成功（惰性建目录兜底生效）；同步总时长日志显示 folder 与 note 清单发送时间重叠；FolderSyncEnd 丢失场景下 note/file 同步不再被挂 30s。

**C5 · 分片临时目录竞态补齐**
- 文件：`src/lib/sync/operator_file.ts`（958-967 与 1099-1107 两处 exists→mkdir 包 try/catch，catch 后 `adapter.exists` 复验，存在则吞、不存在走现有失败路径）。
- 验收：并发 8 个附件下载会话首次建 tempDir 无异常；人为预建目录后再触发 mkdir 路径不报错。

**C6 · 顺手项（一并出包，不阻塞主线）**
- `concurrencyControlEnabled` 默认改 true、`maxConcurrentUploads` 默认 20（E2E 分析 P6）；`src/lib/sync/websocket_action.ts` 无需改（零新 action）。
- 验收：默认配置下批量 NeedPush 补传在途 ≤20；设置页开关行为不变。

**联调剧本（双端各自过验收后）**：新×新（1 万文件全量 + 增量 + 断线重连 + 丢包模拟）/ 新×旧 / 旧×新 三组合各跑全量+增量一轮，比对同步后两端文件树 hash 一致；记录三组合的同步耗时基线进 PR 描述。

---

## 7.5 实现落地状态（2026-07-09 当日完成）

- **服务端**：S2 `a55c6413` → S1 `ad8d4af9` → S3 `756dc41e` → S4 `f0af426d` → S5 `3e34a259` → 信封修正 `a01415bb`。build/vet/-race 全绿。
- **客户端**：C5 `1b5a915` → C4 `8642ce6` → C6 `ff2d72b` → C1 `75f51c2` → C2 `414304e` → C3 `667a57c`。build 全绿。
- **协议修正（对 §2.4 的更正）**：WSResponse 信封 pageIndex 线上值为 **1-based**（0/缺省=非分页，n>0=第 n-1 页），因 proto3 零值不上线，0-based 会使第 0 页与非分页广播消息在 pb 模式下无法区分。PageAck 请求字段保持 0-based（首拉 -1）。1-based→0-based 转换统一在客户端 websocket_manager.ts 一处。
- **已知限制**：服务端窗口回退整页重发时，若原发送的部分明细仍在客户端处理中、与重发明细交错，页 completedCount 幂等闸门无法区分重复项与真未完成项，存在窄窗口的 ack 时刻偏差（不丢数据，最坏走 15s 停滞重发/300s 兜底）。完整修复需 (pageIndex,path) 级去重集合，触发条件极窄（ack 丢失 + 原明细在飞），暂列已知限制。
- **463 会话丢失错误路径**（receiveFileUploadSessionNotFound）无 pageIndex 可用，保留旧路径归账，影响面仅该错误恢复分支。
- **未做**：三组合联调剧本（新×新/新×旧/旧×新 实测）——需要真实服务端+测试库环境，见 §7.2 尾注。

## 8. 风险与回滚

| 风险 | 等级 | 缓解 / 回滚 |
|---|---|---|
| 窗口协议实现 bug 导致数据错漏 | 高危 | ① 集合语义不变：doSync 输入与下发明细集合在两种模式下逐元素相等，有 S5 集成测试锁住；② **运行时回滚开关**：后台把 `pipeline-window-up/down` 设 0，所有连接下一轮同步即回 stop-and-wait，**无需回滚版本**；③ 灰度：3.6.0 可先以窗口=0 默认值发布，观察一周后后台调 8/4 |
| 客户端页归账改造回归（tracker 是历史 bug 高发区，见 b37f69d/ba98cfe） | 中 | pages Map 与旧全局计数双路并存（按 payload 有无 pageIndex 自动选路），旧路径零改动；C3 验收含全部历史回归用例（双发 ack、小于一页、乱序页） |
| pb 提前升级与旧客户端兼容 | 中 | 升级严格以 pv=2 为闸；无 pv 连接路径零改动。风险点是 auth 响应发送与 setUseProtobuf 的顺序——工单已锁定「先发 JSON 响应再切 pb」，加集成测试断言 auth 响应帧为文本帧 |
| 上行重传与服务端 doSync 竞态（迟到重传重建孤儿 entry） | 低 | 客户端 SyncEnd 后停止重传收窄窗口；孤儿 entry 5min TTL 回收；S3 加 Debug 日志可观测 |
| 四类并发发送放大瞬时内存/缓冲 | 低 | 共享 bufferedAmount 5MB 背压不变；清单消息体量小（无正文），实测 1 万文件清单 pb 后 ≈1.5MB 总量 |
| 版本组合爆炸 | 低 | 兼容矩阵仅 2×2 且新行为全部收敛于「协商块存在与否」单一判据；联调剧本覆盖三组合 |

**回滚路径总结**：服务端配置窗口=0（运行时，秒级）→ 客户端因协商值为 0 自动退回；极端情况回滚服务端到 3.5.x——2.3.0 客户端因 auth 响应无协商块整体退回现行为，兼容不破。

---

## 附：关键代码位置速查

| 主题 | 位置 |
|---|---|
| 上行批发送（改造对象） | fastnotesync `src/lib/sync/operator.ts:993-1052` sendSyncInBatches |
| folder 屏障（删除对象） | fastnotesync `src/lib/sync/operator.ts:1093-1113` |
| 服务端批归集 | fast-note-sync-service `internal/routers/websocket_router/ws_note.go:650-719` + `ws_sync_batch_cache.go` |
| 服务端分页发送 | `ws_sync_download_cache.go:83-155` sendSyncPage + `ws_note.go:1117-1176` PageAck |
| Auth 响应 | `pkg/app/websocket.go:1092-1173` Authorization |
| ClientInfo | `pkg/app/websocket.go:1176-1227` / fastnotesync `src/lib/utils/version_manager.ts:106-146` |
| 客户端页进度 | fastnotesync `src/lib/sync/sync_progress_tracker.ts` / `src/main.ts:107-134` sendSyncPageAck |
| 惰性建目录三处 | `operator_note.ts:264-278` / `operator_file.ts:1303-1315`（已有）/ `operator_file.ts:958-967,1099-1107`（C5 待补） |
| proto 生成链 | 服务端 `internal/proto/v1/sync.proto` → 客户端 `pnpm proto`（pbjs/pbts + scripts/fix-proto.cjs） |
