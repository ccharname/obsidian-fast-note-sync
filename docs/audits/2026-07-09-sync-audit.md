# 双项目同步性能与稳定性审计报告（2026-07-09）

审计对象：fastnotesync（Obsidian 插件 v2.2.0，~30k 行 TS）+ fast-note-sync-service（Go v3.5.0，~70k 行）。
方法：5 路并行深度代码审计（客户端性能 / 客户端稳定性 / 服务端性能 / 服务端稳定性 / 协议 E2E 架构分析），全部发现均有 file:line 代码证据，无推测项。

## 核心结论

1. **同步慢的第一根因是协议层 stop-and-wait**：上行分批等 BatchAck、下行分页等 PageAck，全是「发一个等一个」。1 万文件全量 ≈ 300 个串行 RTT，公网 50ms RTT 下光往返等待就是 15-60 秒，与带宽无关。
2. **大库卡顿/白屏的真凶是客户端三条未节流的消息副作用链**：日志系统 O(n²) 扫描、哈希表逐条 Ack 整表 JSON.stringify 写 localStorage（历史"白屏"修复只覆盖了上传扫描方向，下载/Ack 方向原样复发）、进度通知无节流刷 UI。
3. **服务端"大库无法同步"的隐藏根因**：note 表缺 (vault_id, path_hash) 复合索引（同类 file/folder/setting 表都有），点查退化全表扫，全量上传近 O(N²)；外加全量同步对每行做 2 次串行 ReadFile 且大半白读。
4. **数据丢失级 P0 bug 共 8 个**（详见下），最严重的是服务端 singleflight 误用（并发写同一笔记，后到者内容永不落库却收到成功 Ack）和客户端远端推送盲覆盖本地正在进行的编辑。

## P0 清单

### 服务端（fast-note-sync-service）
| # | 问题 | 位置 | 风险 |
|---|---|---|---|
| S1 | note 表缺 (vault_id, path_hash) 索引，点查 O(N)、全量上传 O(N²) | model/note.gen.go:19, dao/note_repository.go:237-280 | 修复:低 |
| S2 | singleflight 误用：并发写同一笔记/文件，后到者闭包永不执行，内容静默丢失但收到成功 Ack | service/note_service.go:314-320, file_service.go:245-251 | 修复:中 |
| S3 | 文件 rename 落盘失败被 `_ =` 吞掉，DB 与磁盘不一致 | dao/file_repository.go:232-240, 265-274 | 修复:低 |
| S4 | 备份/git/vault/cloudflare 后台 goroutine 无 panic recover，一个 panic 杀全进程 | service/backup_service.go:326, git_sync_service.go:403 等多处 | 修复:低 |
| S5 | 全量同步逐行 2 次 ReadFile（2 万次 IO），hash 相同的白读后即丢弃 | dao/note_repository.go:169-222, ws_note.go:922-925 | 修复:低-中 |
| S6 | 下载分页 stop-and-wait，200 页=200 RTT；「下载速度控制」的实现就是 ack 步进本身 | ws_sync_download_cache.go:65-107, config/app.go:78 | 短期调页大小:低；滑动窗口:高(协议) |
| S7 | per-user 写队列严格串行+每 op 复合多段操作，上传吞吐天花板极低 | pkg/writequeue/manager.go:271-300, dao/note_repository.go:322-364 | 修复:中 |
| S8 | sync_log 每条变更裸开 goroutine 单条 INSERT，万级上传瞬间万个 goroutine 抢 DB | service/sync_log_service.go:56-99 | 修复:低 |

### 客户端（fastnotesync）
| # | 问题 | 位置 | 风险 |
|---|---|---|---|
| C1 | 远端推送写盘前不比较本地当前内容，同步窗口内的用户编辑被静默覆盖 | operator_note.ts:234-235, operator_config.ts:177 | 修复:中(冲突UX) |
| C2 | 断线时 concurrencyLimiter.clear() 丢弃排队 Promise → withLock 永不释放 → 该文件永久无法同步 | concurrency_limiter.ts:116-122 + lock_manager.ts:56-69 | 修复:低 |
| C3 | SendBinary 断线返回 false 与成功同值，分片上传断线静默"空转跑完"，文件被误标已传 | websocket_client.ts:420-453, operator_file.ts:549-601 | 修复:中 |
| C4 | 目录删除等待清空超时后仍无条件强制递归删除，未下载完/新建的本地文件被抹掉 | operator_folder.ts:216-235 | 修复:中 |
| C5 | rename Ack 盲 FIFO 匹配，断线丢 ack 后错位，把 B 的 hash 写到 A 的路径 | operator_note.ts:593-607 | 需协议加字段 |
| C6 | 配置离线编辑因水位线竞态永久丢失（笔记路径有 pending 防护、配置路径没有） | operator.ts:466-467, 761 vs 573 | 修复:低 |
| C7 | 哈希/快照缓存在下载/Ack 路径仍逐条整表 JSON.stringify 写 localStorage（历史白屏 bug 换路径复发，git show 1a6bb37 可证只修了上传方向） | file_hash_manager.ts:162-165, folder_snapshot_manager.ts:79-92, config_hash_manager.ts:169-172 | 修复:低 |
| C8 | SyncLogManager 每条消息 O(n) findIndex + getLogs 全量拷贝喂 React，5000 上限下 O(n²) | sync_log_manager.ts:63, 284; websocket_manager.ts:260-263 | 修复:低 |

## P1/P2 要点

**服务端**：upsertFTS 冗余 SELECT（note_repository.go:995，性价比最高一条）；NoteModify 同行双查（note_service.go:270/322）；批次上传无 BatchIndex 去重——与已修的 PageAck 重复 bug 同源只修一半（ws_sync_batch_cache.go）；PageAck mismatch 静默丢弃可致客户端卡到 10min TTL（ws_note.go:1118-1124）；ClientInfo 连接级字段无锁读写，gws 并行分发下真实数据竞争（pkg/app/websocket.go:1075-1127）；git-sync 未启用也每变更查一次配置（git_sync_service.go:1082）；下载缓存全量正文物化内存 10min TTL，多用户重连风暴有 OOM 风险（ws_sync_download_cache.go:14-27）；广播顺序阻塞写，慢设备拖快设备（websocket.go:646-685）；启动全量 FID 重扫撞升级重连高峰（task_sync_fid.go）；file 列表每行 os.Stat（file_repository.go:108-134）；DB 连接池 LRU 淘汰无引用计数（dao.go:207-220,328-345）；冲突合并 diff 关闭行级优化（pkg/diff/diff.go）。

**客户端**：分页控制消息非幂等（receivedTaskTotal 盲累加、isLast 盲覆盖），重复/乱序致卡 300s 超时且超时分支不查下载会话就报"完成"（sync_progress_tracker.ts:212-215, operator.ts:46-72）；断连孤儿同步会话 catch 清掉新会话 context（operator.ts:907-915）；onunload 不调 cancelSync，定时器操作已销毁实例（main.ts:615-623）;重连 15 次后永久放弃且无提示（websocket_client.ts:328-347）；文件夹快照初始化后从不与真实 vault 对账（folder_snapshot_manager.ts:27-35）；写失败仍计入"已完成"驱动虚假成功（operator_note.ts:275-282 等）；Send() 丢弃消息日志却写"queuing"（websocket_client.ts:379-383）；进度通知无节流（sync_progress_tracker.ts:158-183）；folder-gate 硬屏障串行 30s（operator.ts:1093-1113）；扫描哈希纯串行无并发（operator.ts:533-646）；首同步前固定 500ms 无条件延迟（websocket_manager.ts:381-384）；缺失检测每次增量都 O(库大小)（operator.ts:660-721）；上传并发限流默认关闭（setting.tsx:158）。

## 协议 E2E 时序（冷启动增量 ≈ 6-8 串行 RTT）

WS 握手(~2) → Authorization(1) → ClientInfo(1，批大小/protobuf 升级依赖它但 sync 不等它，存在竞态) → FolderSync+硬屏障(~1，最坏挂 30s) → Note/File/Setting(管线化~1) → 下行逐页各+1~M。
元数据对比 = lastTime 时间戳游标 + pathHash/contentHash/mtime 三元组，无 version vector/oplog。全量态 1 万文件清单 ≈ 1-1.6MB / 100 批 / 100 串行 RTT。

## 架构级改进排序（需拍板）

1. **上下行滑动窗口流水线化**（收益★★★★★，成本中，破坏性双端升级）——cache 已按 index/page 组织，改的是许可逻辑非数据面；与官方 Sync 差距的第一根因
2. **auth+clientinfo 合并 + folder 屏障去除**（收益★★★，成本低，加字段兼容/纯客户端）——每次同步省 1-2 RTT + 消除 30s 长尾，建议最先做
3. **Merkle 目录树对账**（收益★★★★ 但集中在首次/重连/对账，成本高）——建议先量化全量占比再投
4. **正文与元数据解耦 + 字节分页**（收益★★，成本中，破坏性）——排最后

## 修复落地状态（2026-07-09 当日完成，共 38 项）

- **客户端第一波 12 项**：`4c76723..abc1313`（锁悬挂/配置离线丢失/防抖落盘/日志Map化/进度节流/生命周期/分页幂等/重连上限/目录误删/盲覆盖/分片三态/日志文案）
- **服务端第一波 12 项**：`58ee8b79..06b7b17f`（note索引/upsertFTS/重复查询/singleflight→keyedmutex/rename吞错/safego recover/sync_log攒批/BatchIndex去重/PageAck兜底重发/git-sync缓存/ClientInfo锁/页大小200）
- **客户端第二波 6 项**：`f01ec65..861ee4f`（会话污染/6路并发哈希/startupDelay仅首连/失败独立计数/快照对账/高频日志降持久化）
- **服务端第二波 8 项**：`07f34e3e..ed3d04e0`（按需读正文+分页回填/批量删除/写队列drain/os.Stat缓存/GetTree聚合——顺带修出 GORM fid 列名映射真bug/diff动态checklines/广播锁外并发/连接池防误关）
- 验证：两仓 build/vet 全绿，涉及并发处 -race 测试通过；两个既有失败测试（middleware webgui_auth、api_router RebuildIndex mock）经 stash 验证与本次改动无关
- **未做（待拍板）**：滑动窗口流水线化、auth+clientinfo 握手合并、folder 硬屏障去除、rename ack 带 path、Merkle 树、正文/元数据解耦、增量缺失检测降频（协议语义）

## 已核实不构成问题的点

SQLite WAL+busy_timeout+FIFO 写队列+退避重试稳；文件分片上传幂等性好（session.mu 双重判断）；task/scheduler 自身有 recover 且不重叠执行；deecf1b0 修的 PageAck 双发未回归。
