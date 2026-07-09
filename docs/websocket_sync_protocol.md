# WebSocket 同步协议对接文档

本文档按照 **“发送请求 -> 接收响应 -> 详细结构”** 的逻辑组织，供前端开发人员参考。

> **客户端 2.3.0 / 服务端 3.6.0**：协议流水线化改造——握手合并（§4）、上行分批滑动窗口（§5）、下行分页滑动窗口（§6）。全程能力协商，与旧版本双向兼容，兼容矩阵见 §7；旧行为标注为「≤2.2.x 客户端 / 服务端 ≤3.5.x」。

---

## 1. 笔记同步 (`NoteSync`)

### 第一步：客户端发送同步请求
**Action**: `NoteSync`
**参数结构:**
```json
{
  "vault": "MyVault",             // 仓库名称
  "lastTime": 1704560000000,      // 客户端记录的上次同步时间戳 (毫秒)
  "notes": [                      // 客户端本地的笔记信息清单
    {
      "path": "test/abc.md",      // 路径
      "pathHash": "32位哈希",      // 路径唯一标识
      "contentHash": "内容哈希",   // 用于判定内容是否变动
      "mtime": 1704560000000      // 修改时间 (毫秒)
    }
  ]
}
```

> 清单较大时，客户端按协商的 `syncUpChunkNum`（默认 100，见 §4）拆成多批依次发送多条 `NoteSync` 请求。**2.3.0+** 起多批之间为滑动窗口流水线（不再逐批等确认），详见 §5；**≤2.2.x 客户端 / 服务端 ≤3.5.x** 仍为逐批 stop-and-wait。

### 第二步：服务端返回同步结果通知
**Action**: `NoteSyncEnd`
**数据结构 (`data` 字段内容):**
```json
{
  "lastTime": 1704569999999,      // 本次同步后最新的服务端时间戳 (下次同步请传这个值)
  "messages": [                   // 任务队列：需要客户端执行的具体操作
    { "action": "NoteSyncDelete", "data": { ... } },
    { "action": "NoteSyncModify", "data": { ... } },
    { "action": "NoteSyncNeedPush", "data": { ... } },
    { "action": "NoteSyncMtime",  "data": { ... } }
  ],
  "needUploadCount": 1,           // 统计：需上传数
  "needModifyCount": 1,           // 统计：需下载修改数
  "needDeleteCount": 1,           // 统计：需删除数
  "needSyncMtimeCount": 1         // 统计：仅需同步时间数
}
```

> `messages` 中列出的下行明细，实际是按页分批下发的（`NoteSyncPage` 元数据 + 明细消息，非一次性打包在 `NoteSyncEnd` 内），此处按逻辑关系合并展示。**2.3.0+** 起多页之间为滑动窗口流水线（服务端预推多页、客户端边收边写盘），且每条明细的信封新增 `pageIndex` 字段标注所属页，详见 §6；**≤2.2.x 客户端 / 服务端 ≤3.5.x** 仍为逐页 stop-and-wait，明细不带 `pageIndex`。

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)      | 对应 Data 结构                                                                   | 说明                                                   |
|:-----------------------|:---------------------------------------------------------------------------------|:-------------------------------------------------------|
| **`NoteSyncDelete`**   | `{ "path": "string" }`                                                           | 服务端已删，客户端应删除本地对应文件                    |
| **`NoteSyncNeedPush`** | `{ "path": "string" }`                                                           | 客户端本地更新，需客户端再次发送 `NoteModify` 进行上传  |
| **`NoteSyncModify`**   | `{ "path", "pathHash", "content", "contentHash", "ctime", "mtime", "lastTime" }` | 服务端较新，客户端应直接使用 Data 中的 content 覆盖本地 |
| **`NoteSyncMtime`**    | `{ "path", "ctime", "mtime" }`                                                   | 内容一致，仅需更新本地文件的修改时间                    |

---

## 2. 文件同步 (`FileSync`)

### 第一步：客户端发送同步请求
**Action**: `FileSync`
**参数结构:**
```json
{
  "vault": "MyVault",
  "lastTime": 1704560000000,
  "files": [
    {
      "path": "img/a.png",
      "pathHash": "...",
      "contentHash": "...",
      "size": 10240,              // 文件大小 (字节)
      "mtime": 1704560000000
    }
  ]
}
```

> 分批上行/滑动窗口规则与 §1 笔记同步一致（清单按 `syncUpChunkNum` 拆批，详见 §5）。

### 第二步：服务端返回同步结果通知
**Action**: `FileSyncEnd`
**数据结构:** 与 `NoteSyncEnd` 类似。分页下行/滑动窗口规则与 §1 一致，详见 §6。

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)    | 对应 Data 结构                                                                | 说明                                                        |
|:---------------------|:------------------------------------------------------------------------------|:------------------------------------------------------------|
| **`FileSyncDelete`** | `{ "path": "string" }`                                                        | 服务端已删                                                  |
| **`FileSyncUpdate`** | `{ "path", "pathHash", "contentHash", "size", "ctime", "mtime", "lastTime" }` | 服务端较新，客户端应发起 `FileChunkDownload` 进行下载        |
| **`FileUpload`**     | `{ "path", "sessionId", "chunkSize" }`                                        | 客户端较新，请求上传。客户端需根据 `sessionId` 发送二进制分块 |
| **`FileSyncMtime`**  | `{ "path", "ctime", "mtime" }`                                                | 仅同步修改时间                                              |

---

## 3. 设置同步 (`SettingSync`)

### 第一步：客户端发送同步请求
**Action**: `SettingSync`
**参数结构:**
```json
{
  "vault": "MyVault",
  "lastTime": 1704560000000,
  "cover": false,                 // 是否强制云端覆盖本地
  "settings": [ ... ]             // 结构同笔记同步
}
```

> 分批上行/滑动窗口规则与 §1 一致（详见 §5）。

### 第二步：服务端返回同步结果通知
**Action**: `SettingSyncEnd`
**数据结构:** 结构同上。分页下行/滑动窗口规则与 §1 一致，详见 §6。

### 第三步：详细任务数据结构 (`messages[i].data`)

| 任务类型 (Action)           | 对应 Data 结构                                                                            | 说明                                             |
|:----------------------------|:------------------------------------------------------------------------------------------|:-------------------------------------------------|
| **`SettingSyncDelete`**     | `{ "path": "string" }" }`                                                                 | 删除本地配置                                     |
| **`SettingSyncModify`**     | `{ "vault", "path", "pathHash", "content", "contentHash", "ctime", "mtime", "lastTime" }` | 服务端较新，覆盖本地                              |
| **`SettingSyncNeedUpload`** | `{ "path": "string" }`                                                                    | 客户端较新，需客户端发起 `SettingModify` 进行上传 |
| **`SettingSyncMtime`**      | `{ "path", "ctime", "mtime" }`                                                            | 仅同步时间                                       |

---

## 4. 握手与能力协商

> 客户端 **2.3.0** / 服务端 **3.6.0** 起支持。一切新行为由双方在握手阶段显式协商开启，任一方版本不支持即整体退回 **≤2.2.x/服务端≤3.5.x 行为**（stop-and-wait），不存在半开启状态。兼容矩阵见 §7。

### 4.1 连接握手（URL Query）

客户端发起 WS 连接（`/api/user/sync`）时，除原有 `client`/`clientName`/`clientVersion`/`protocol` 参数外，新增两个协商参数：

| 参数 | 说明 |
|---|---|
| `pv=2` | 协议版本声明：客户端支持 v2 握手协商（auth 响应携带协商块、上下行窗口流水线、pb 提前升级）。 |
| `pb=1` / `pb=0` | 客户端本地 `protobufEnabled` 设置的实时值。`pv=2` 起以此为准，取代此前恒带 `protocol=protobuf` 但与真实设置脱节的问题。 |

服务端在 HTTP upgrade 时解析并记录到连接：`ProtoVersion`（来自 `pv`）、`PbEnabled`（来自 `pb`）。**≤2.2.x 客户端**不带 `pv` 参数，服务端视为 v1 连接。

### 4.2 Auth 响应协商块

**Action**: `Authorization`
成功响应的 `data` 在 `pv>=2` 且服务端为 3.6.0+ 时，除原有字段外追加协商块（五个字段）：

```jsonc
{
  "version": "...", "gitTag": "...", "buildTime": "...", "changelog": "...",  // 原有字段，不动
  // ---- 以下仅 pv>=2 且服务端支持时追加 ----
  "syncUpChunkNum": 100,       // 上行每批条数（此前需等 ClientInfo 响应才知道）
  "syncDownChunkNum": 200,     // 下行每页条数
  "pipelineWindowUp": 8,       // 上行滑动窗口大小（在途批数上限）。0 = 服务端要求 stop-and-wait
  "pipelineWindowDown": 4,     // 下行滑动窗口大小（在途页数上限）。0 = stop-and-wait
  "protobufAck": true          // 服务端确认本连接将启用 protobuf（= 服务端 protocol=="protobuf" && pb==1）
}
```

客户端在发起同步（`StartHandle`）之前解析并写入本地 `syncState`，保证首批发送即用上协商值，消除此前"默认值抢跑"的竞态；`protobufAck===true` 时立即切换 protobuf 编码，不必再等 `ClientInfo` 响应触发升级。

**≤2.2.x 客户端 / 服务端 ≤3.5.x 行为**：auth 响应无协商块（旧客户端也会忽略未知 key，天然兼容）。`syncUpChunkNum`/`syncDownChunkNum` 靠随后的 `ClientInfo` 响应下发，protobuf 升级同样等 `ClientInfo` 响应触发；上下行一律 stop-and-wait（见 §5、§6）。

---

## 5. 上行分批：滑动窗口（BatchAck）

`NoteSync`/`FileSync`/`SettingSync`（含 FolderSync）清单较大时，客户端按协商的 `syncUpChunkNum` 切分为多批发送。

### 5.1 窗口语义（2.3.0+，双方协商成立时）

- 窗口大小 `W = min(pipelineWindowUp, 32)`。客户端不再"发一批等一批"，而是连续发送最多 `W` 批（不等确认），随着 `BatchAck` 陆续到达滚动补发后续批，形成流水线。
- **`XxxSyncBatchAck{context, batchIndex}` 语义变化**：不再是"允许发送下一批"的许可信号，而是"批 `batchIndex` 已收到"的窗口滑动信号——语义升级，消息结构不变。
- **服务端现在对最后一批也回 `BatchAck`**：此前集齐全部批次后直接触发对应的 `XxxSyncEnd`，不单独确认最后一批；现在无条件先回 `BatchAck` 再判断是否集齐，多出的确认对旧客户端无影响（无监听者时静默丢弃）。
- 单批确认超时 10s，超时重传，同一批最多重传 3 次；3 次仍失败则本轮同步失败并复位状态（用户可手动重试）。收到对应类型的 `XxxSyncEnd` 视为全部在途批次隐式确认。
- 服务端幂等：批次按 `batchIndex` 去重，重复批只会重发确认、不会重复写入。

窗口是否启用完全由客户端驱动（服务端没有独立的"窗口开关"，客户端连发几批就逐批确认几批）；无协商块时客户端固定退回 stop-and-wait，见 §7 兼容矩阵。

### 5.2 ≤2.2.x 客户端 / 服务端 ≤3.5.x 行为（stop-and-wait）

客户端发送一批后停止发送，等待该批 `BatchAck` 到达才发下一批；集齐全部批次时服务端不回最后一批的 `BatchAck`（客户端也不等它）。全量清单 100 批 ≈ 100 个串行 RTT。

---

## 6. 下行分页：滑动窗口（PageAck）

服务端按 `syncDownChunkNum` 把变更集切分为多页下发，每页含一条 `XxxSyncPage` 元数据消息（该页条数）+ 该页内的明细消息（`XxxSyncModify`/`XxxSyncDelete`/`XxxSyncMtime`/`XxxSyncNeedPush` 等，见各节第三步）。

### 6.1 窗口语义（2.3.0+，双方协商成立时）

- 服务端维护每类型下载状态：`SentPage`（已发出页数）、`AckedPage`（已确认处理完的最高连续页水位）、`Window`（协商窗口大小，取 `pipelineWindowDown`，0=stop-and-wait）。
- 首拉：客户端在收到对应类型 `XxxSyncEnd` 后发 `XxxSyncPageAck{pageIndex:-1}`，服务端据此连发 `min(Window,总页数)` 页（不等逐页确认）。
- **`XxxSyncPageAck{context, vault, pageIndex}` 语义变化**：从"请求下一页"变为"页 `pageIndex` 已处理完"（流控水位推进）——**采用"最高水位"语义而非逐页确认集合**：客户端发 `ack(n)` 即代表页 `0..n` 全部处理完毕（写盘完成），必须确认前面页确实都完成才能发出该 ack，不能提前发。
- 服务端收到 `ack(n)` 后按水位推进：`n` 在 `[AckedPage-1, SentPage)` 区间内正常推窗；`n == AckedPage-1`（客户端重发上一次确认，说明没收到后续页）触发**整页重发**：回退发送游标，重发窗口内的页；`n >= SentPage`（客户端确认了未发过的页）视为异常忽略。
- **整页重发幂等**：客户端凭 `receivedPageIndexes` 按页去重，重复到达的整页（含其全部明细）会被识别并丢弃，不会重复计数、不会重复写盘。
- 每页发送完毕即视为"发出"；`isLast` 页发完服务端即释放该下载会话（现状保留，`isLast` 页客户端不回确认）。

### 6.2 下行明细信封：`pageIndex` 字段

**所有下行消息的最外层信封**新增 `pageIndex` 字段，标注该条消息所属页：

```jsonc
{
  "action": "NoteSyncModify",
  "code": 0,
  "context": "...",
  "pageIndex": 1,        // 见下方取值说明
  "data": { "path": "...", "content": "...", "...": "..." }
}
```

**取值语义（线上落地值，1-based）**：`0` 或字段缺省 = 非分页 / 广播消息；`n > 0` = 属于下载的第 `n-1` 页（客户端内部按 0-based 计页，在 `websocket_manager.ts` 单点统一转换）。之所以线上是 1-based：`pageIndex` 走 proto3 字段，零值不上线（不占用线宽），若用 0-based 会导致"第 0 页"与"非分页广播消息"在 protobuf 模式下无法区分，故落地时整体加一；`XxxSyncPageAck` 请求字段本身仍保持 0-based（首拉为 `-1`）。

多页在途时，客户端按 `pageIndex` 对每页的接收/写盘完成情况独立计数（不再是单页覆盖式计数），全部完成才对该页发确认，天然支持乱序完成（例如页 2 比页 1 先写完）。

### 6.3 ≤2.2.x 客户端 / 服务端 ≤3.5.x 行为（stop-and-wait）

服务端逐页发送、逐页等待确认：收到上一页 `PageAck` 才发下一页；明细消息不带 `pageIndex`（或为 0），客户端按单页计数处理。`PageAck` mismatch（收到的确认号落后于当前页）时服务端重发当前页，语义等价于新分支表中 `n==AckedPage-1` 的整页重发分支——新旧实现在 Window=0 时逐消息行为一致。

---

## 7. 兼容性矩阵

**总原则：一切新行为由双方在 auth 阶段显式协商开启，协商块缺席（任一方版本不支持）即整体退回 stop-and-wait，不存在半开启状态。**

| 客户端 \ 服务端 | 旧（服务端 ≤3.5.x） | 新（服务端 3.6.0+） |
|---|---|---|
| 旧（客户端 ≤2.2.x） | 现状：握手不带 `pv`，auth 响应无协商块，全程 stop-and-wait，`ClientInfo` 响应后升级 protobuf | auth 响应多出的协商字段被旧客户端忽略（JSON 未知 key）；无 `pv` 参数 → 服务端不提前升级 pb、窗口无从谈起 → **整体退回 stop-and-wait**（服务端窗口本就由客户端 `pv` 判定是否启用） |
| 新（客户端 2.3.0+） | auth 响应无协商块 → 客户端判定服务端为 v1，**全部退回现行为**（等 `ClientInfo` 升级 pb、上下行 stop-and-wait）| **全量新行为**：握手合并、上下行滑动窗口、`pageIndex` 分页信封 |

判据只有一个：**auth 响应里有没有协商块**（`pipelineWindowUp` 等字段存在与否）。判定结果落在客户端 `syncState.negotiated`，同一连接内全程有效，不会中途切换。

**回滚**：服务端后台把 `pipeline-window-up`/`pipeline-window-down` 置 0，所有连接下一轮同步即整体退回 stop-and-wait，无需回滚客户端/服务端版本。

> 已知实现限制（E2E 实测 2026-07-09 发现）：通过服务端**配置文件**显式写 `pipeline-window-up: 0` 目前不生效（配置二次填充默认值的机制会把显式 0 当"未设置"重新覆盖为默认 8/4），仅**管理后台运行时**改 0 立即生效，但服务重启后会静默恢复窗口模式。紧急回滚请使用管理后台改值，不要依赖静态配置文件（该缺陷待服务端后续修复）。

---

## 8. 二进制分块协议
在分块上传/下载时，二进制帧的前 **40 字节** 为固定报头：
- **0~35 字节**: `SessionID` (UUID 字符串)
- **36~39 字节**: `ChunkIndex` (uint32, 大端序)
- **40 字节开始**: 分块原始数据
